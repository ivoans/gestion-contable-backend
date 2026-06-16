// tests/middleware/auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { EstadoActivo } from '../../src/middleware/userStatus';
import { makeUser } from '../helpers/factories';
import {
  bearerFor,
  expiredBearerFor,
  badSignatureBearerFor,
  MALFORMED_HEADER,
} from '../helpers/auth';

// authenticate consulta `activo` (usuario + estudio) en DB; acá se mockea el
// lookup para controlar cada escenario de revocación sin tocar supabase.
const getEstadoActivoMock = vi.fn<(userId: string) => Promise<EstadoActivo>>();
vi.mock('../../src/middleware/userStatus', () => ({
  getEstadoActivo: (userId: string) => getEstadoActivoMock(userId),
}));

import { authenticate } from '../../src/middleware/auth';

function makeReqRes(authHeader?: string) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('middleware/authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEstadoActivoMock.mockResolvedValue({ ok: true });
  });

  it('401 sin Authorization header', async () => {
    const { req, res, next } = makeReqRes();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token requerido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 si header no empieza con "Bearer "', async () => {
    const { req, res, next } = makeReqRes(MALFORMED_HEADER);
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token requerido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con token expirado', async () => {
    const user = makeUser({ role: 'contador' });
    const { req, res, next } = makeReqRes(expiredBearerFor(user));
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido o expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con firma inválida (secret incorrecto)', async () => {
    const user = makeUser();
    const { req, res, next } = makeReqRes(badSignatureBearerFor(user));
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido o expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con token sintácticamente roto', async () => {
    const { req, res, next } = makeReqRes('Bearer not-a-jwt');
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('no consulta la DB si el token es inválido', async () => {
    const { req, res, next } = makeReqRes('Bearer not-a-jwt');
    await authenticate(req, res, next);
    expect(getEstadoActivoMock).not.toHaveBeenCalled();
  });

  it('next() y req.user con token válido y usuario activo', async () => {
    const user = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
    const { req, res, next } = makeReqRes(bearerFor(user));
    await authenticate(req, res, next);
    expect(getEstadoActivoMock).toHaveBeenCalledWith(user.id);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({
      id: user.id,
      email: user.email,
      role: user.role,
      estudio_id: user.estudio_id,
    });
  });

  it('preserva role admin con estudio_id null', async () => {
    const admin = makeUser({ role: 'admin' });
    const { req, res, next } = makeReqRes(bearerFor(admin));
    await authenticate(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.role).toBe('admin');
    expect(req.user?.estudio_id).toBeNull();
  });

  it('401 si el usuario fue desactivado (token vivo revocado)', async () => {
    getEstadoActivoMock.mockResolvedValue({ ok: false, reason: 'usuario_inactivo' });
    const user = makeUser({ role: 'cliente', estudio_id: 'estudio-1' });
    const { req, res, next } = makeReqRes(bearerFor(user));
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cuenta desactivada' });
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('401 si el estudio del usuario fue desactivado', async () => {
    getEstadoActivoMock.mockResolvedValue({ ok: false, reason: 'estudio_inactivo' });
    const user = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
    const { req, res, next } = makeReqRes(bearerFor(user));
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Estudio desactivado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('500 si falla el lookup en DB (fail-closed)', async () => {
    getEstadoActivoMock.mockResolvedValue({ ok: false, reason: 'error_db' });
    const user = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
    const { req, res, next } = makeReqRes(bearerFor(user));
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno del servidor' });
    expect(next).not.toHaveBeenCalled();
  });
});
