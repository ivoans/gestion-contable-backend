// tests/middleware/roles.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireRole } from '../../src/middleware/roles';
import type { JwtPayload, Role } from '../../src/types';

function makeReqRes(user?: JwtPayload) {
  const req = { user } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

const userOf = (role: Role): JwtPayload => ({
  id: 'u1',
  email: 'u@t.local',
  role,
  estudio_id: role === 'admin' ? null : 'e1',
});

describe('middleware/requireRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('401 sin req.user', () => {
    const { req, res, next } = makeReqRes(undefined);
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No autenticado' });
    expect(next).not.toHaveBeenCalled();
  });

  it('403 si rol no autorizado', () => {
    const { req, res, next } = makeReqRes(userOf('cliente'));
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permiso para esta acción' });
    expect(next).not.toHaveBeenCalled();
  });

  it('next() si rol coincide', () => {
    const { req, res, next } = makeReqRes(userOf('admin'));
    requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('multi-rol: acepta cualquiera de los listados', () => {
    const { req, res, next } = makeReqRes(userOf('contador'));
    requireRole('admin', 'contador')(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('multi-rol: rechaza fuera de la lista', () => {
    const { req, res, next } = makeReqRes(userOf('cliente'));
    requireRole('admin', 'contador')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
