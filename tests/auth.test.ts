// tests/auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';

// Mocks hoisted: deben existir antes que los imports del SUT.
// vi.hoisted ejecuta su factory antes que cualquier import del archivo.
// Usamos async + dynamic import porque require síncrono no resuelve módulos .ts en Vite.
const { sb, bcryptMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return {
    sb: createSupabaseMock() as SupabaseMock,
    bcryptMock: { compare: vi.fn() },
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/middleware/rateLimits', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('bcryptjs', () => ({ default: bcryptMock }));

import { createApp } from '../src/app';

describe('POST /api/auth/login', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    sb.reset();
    bcryptMock.compare.mockReset();
    app = createApp();
  });

  it('400 si falta email', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Email y password requeridos' });
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si falta password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si body vacío', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('401 si user no existe', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: null } }]);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'noexiste@b.com', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Credenciales inválidas' });
    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it('500 si DB devuelve error', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: { message: 'boom' } } }]);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'x@y.com', password: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Error interno del servidor' });
  });

  it('403 si user inactivo', async () => {
    const user = makeUser({ activo: false });
    sb.queue([
      { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
    ]);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Usuario inactivo' });
    // Inactivo corta antes de comparar password.
    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it('401 si password incorrecta', async () => {
    const user = makeUser();
    sb.queue([
      { table: 'users', result: { data: { ...user, password_hash: 'hashed' }, error: null } },
    ]);
    bcryptMock.compare.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'mal' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Credenciales inválidas' });
    expect(bcryptMock.compare).toHaveBeenCalledWith('mal', 'hashed');
  });

  it('200 + token válido + user payload sin password_hash', async () => {
    const user = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
    sb.queue([
      { table: 'users', result: { data: { ...user, password_hash: 'hashed' }, error: null } },
    ]);
    bcryptMock.compare.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'correcto' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toEqual({
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      role: user.role,
      estudio_id: user.estudio_id,
    });
    // No leak password_hash en response.
    expect(res.body.user).not.toHaveProperty('password_hash');

    // El token decodea con el secret de test → firma correcta.
    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET!) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      id: user.id,
      email: user.email,
      role: user.role,
      estudio_id: user.estudio_id,
    });
    // Tiene exp y aproximadamente 8h de TTL.
    expect(typeof decoded.exp).toBe('number');
    expect(typeof decoded.iat).toBe('number');
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(8 * 60 * 60);
  });

  it('login sin remember → token con exp ~8h y expires_at coherente', async () => {
    const user = makeUser();
    sb.queue([
      { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
    ]);
    bcryptMock.compare.mockResolvedValue(true);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'ok' });

    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(8 * 60 * 60);
    // exp ≈ now + 8h con tolerancia de 5s
    expect(Math.abs(decoded.exp - (before + 8 * 60 * 60))).toBeLessThan(5);
    // expires_at refleja exp
    expect(new Date(res.body.expires_at).getTime()).toBe(decoded.exp * 1000);
  });

  it('login con remember:true → token con exp ~10d', async () => {
    const user = makeUser();
    sb.queue([
      { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
    ]);
    bcryptMock.compare.mockResolvedValue(true);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'ok', remember: true });

    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(10 * 24 * 60 * 60);
    expect(Math.abs(decoded.exp - (before + 10 * 24 * 60 * 60))).toBeLessThan(5);
    expect(new Date(res.body.expires_at).getTime()).toBe(decoded.exp * 1000);
  });

  it('login con remember:false → token con exp ~8h (igual que sin enviar)', async () => {
    const user = makeUser();
    sb.queue([
      { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
    ]);
    bcryptMock.compare.mockResolvedValue(true);

    const before = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'ok', remember: false });

    expect(res.status).toBe(200);
    const decoded = jwt.decode(res.body.token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(8 * 60 * 60);
    expect(Math.abs(decoded.exp - (before + 8 * 60 * 60))).toBeLessThan(5);
  });

  it('chain supabase: from(users).select(*).eq(email).maybeSingle()', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: null } }]);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'x@y.com', password: 'x' });
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0].table).toBe('users');
    expect(sb.calls[0].op).toBe('select');
    expect(sb.calls[0].filters).toContainEqual(['eq', 'email', 'x@y.com']);
    expect(sb.calls[0].terminal).toBe('maybeSingle');
  });
});
