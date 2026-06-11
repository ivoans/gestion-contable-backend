// tests/middleware/errorHandler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { MulterError } from 'multer';
import { errorHandler } from '../../src/middleware/errorHandler';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./../helpers/supabaseMock');
  return { sb: createSupabaseMock() };
});

vi.mock('../../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../../src/middleware/rateLimits', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createApp } from '../../src/app';

function makeRes() {
  return {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('middleware/errorHandler (unit)', () => {
  const req = {} as Request;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    next = vi.fn() as unknown as NextFunction;
  });

  it('MulterError LIMIT_FILE_SIZE → 400 JSON', () => {
    const res = makeRes();
    errorHandler(new MulterError('LIMIT_FILE_SIZE', 'archivo'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'El archivo supera el tamaño máximo permitido (5MB)',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('otro MulterError → 400 con el code', () => {
    const res = makeRes();
    errorHandler(new MulterError('LIMIT_UNEXPECTED_FILE', 'x'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Error al procesar el archivo: LIMIT_UNEXPECTED_FILE',
    });
  });

  it('rechazo de CORS → 403 JSON', () => {
    const res = makeRes();
    errorHandler(new Error('CORS: origen no permitido'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'CORS: origen no permitido' });
  });

  it('entity.too.large → 413 JSON', () => {
    const res = makeRes();
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    });
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'Body demasiado grande' });
  });

  it('error desconocido → 500 genérico sin stack', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    errorHandler(new Error('boom interno'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno del servidor' });
    consoleSpy.mockRestore();
  });

  it('si headersSent, delega a next(err)', () => {
    const res = { ...makeRes(), headersSent: true } as unknown as Response;
    const err = new Error('tarde');
    errorHandler(err, req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('errorHandler (integración con createApp)', () => {
  it('JSON malformado en el body → 400 JSON, no HTML', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "rota');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'JSON malformado en el body' });
  });
});
