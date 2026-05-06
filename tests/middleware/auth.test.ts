// tests/middleware/auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authenticate } from '../../src/middleware/auth';
import { makeUser } from '../helpers/factories';
import {
  bearerFor,
  expiredBearerFor,
  badSignatureBearerFor,
  MALFORMED_HEADER,
} from '../helpers/auth';

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
  });

  it('401 sin Authorization header', () => {
    const { req, res, next } = makeReqRes();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token requerido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 si header no empieza con "Bearer "', () => {
    const { req, res, next } = makeReqRes(MALFORMED_HEADER);
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token requerido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con token expirado', () => {
    const user = makeUser({ role: 'contador' });
    const { req, res, next } = makeReqRes(expiredBearerFor(user));
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido o expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con firma inválida (secret incorrecto)', () => {
    const user = makeUser();
    const { req, res, next } = makeReqRes(badSignatureBearerFor(user));
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token inválido o expirado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 con token sintácticamente roto', () => {
    const { req, res, next } = makeReqRes('Bearer not-a-jwt');
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('next() y req.user con token válido', () => {
    const user = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
    const { req, res, next } = makeReqRes(bearerFor(user));
    authenticate(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({
      id: user.id,
      email: user.email,
      role: user.role,
      estudio_id: user.estudio_id,
    });
  });

  it('preserva role admin con estudio_id null', () => {
    const admin = makeUser({ role: 'admin' });
    const { req, res, next } = makeReqRes(bearerFor(admin));
    authenticate(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.role).toBe('admin');
    expect(req.user?.estudio_id).toBeNull();
  });
});
