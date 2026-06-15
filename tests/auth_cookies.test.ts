import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser, makeJWT } from './helpers/factories';

// Mismo scaffolding de mocks hoisted que auth.test.ts.
const { sb, bcryptMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return {
    sb: createSupabaseMock() as SupabaseMock,
    bcryptMock: { compare: vi.fn() },
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
// authenticate hace lookup de activo en DB; lo forzamos a "siempre activo" para no
// interferir con la cola del supabaseMock de cada test.
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/middleware/rateLimits', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('bcryptjs', () => ({ default: bcryptMock }));

import { createApp } from '../src/app';

function cookieArray(res: request.Response): string[] {
  return (res.headers['set-cookie'] as unknown as string[]) ?? [];
}

describe('Sesión por cookie', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    sb.reset();
    bcryptMock.compare.mockReset();
    app = createApp();
  });

  describe('POST /api/auth/login setea cookies', () => {
    it('setea token httpOnly + csrf legible, SameSite=Lax', async () => {
      const user = makeUser();
      sb.queue([
        { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
      ]);
      bcryptMock.compare.mockResolvedValue(true);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'ok' });

      expect(res.status).toBe(200);

      const cookies = cookieArray(res);
      const tokenCookie = cookies.find((c) => c.startsWith('token='));
      const csrfCookie = cookies.find((c) => c.startsWith('csrf='));

      expect(tokenCookie).toBeTruthy();
      expect(tokenCookie).toMatch(/HttpOnly/i);
      expect(tokenCookie).toMatch(/SameSite=Lax/i);

      // csrf debe ser legible por el front => NO httpOnly.
      expect(csrfCookie).toBeTruthy();
      expect(csrfCookie).not.toMatch(/HttpOnly/i);

      // El body sigue trayendo token/user por compatibilidad durante la transición.
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.email).toBe(user.email);
    });
  });

  describe('GET /api/auth/me', () => {
    it('200 + user cuando la cookie token es válida', async () => {
      const user = makeUser({ role: 'cliente', estudio_id: 'estudio-1' });
      const token = makeJWT(user);
      sb.queue([
        { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
      ]);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${token}`]);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(user.id);
      expect(res.body.user).not.toHaveProperty('password_hash');
    });

    it('401 sin cookie ni header', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('sigue funcionando con header Bearer (fallback de migración)', async () => {
      const user = makeUser();
      const token = makeJWT(user);
      sb.queue([
        { table: 'users', result: { data: { ...user, password_hash: 'h' }, error: null } },
      ]);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(user.id);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('200 y limpia las cookies', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);

      const cookies = cookieArray(res).join(' ; ');
      // clearCookie emite la cookie con valor vacío.
      expect(cookies).toMatch(/token=;/);
      expect(cookies).toMatch(/csrf=;/);
    });
  });

  describe('CSRF (double-submit) en mutaciones por cookie', () => {
    it('403 si hay cookie token pero falta el header x-csrf-token', async () => {
      const token = makeJWT(makeUser());
      const res = await request(app)
        .post('/api/_csrf_probe')
        .set('Cookie', [`token=${token}`]);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'CSRF token inválido' });
    });

    it('pasa CSRF si el header coincide con la cookie csrf', async () => {
      const token = makeJWT(makeUser());
      const res = await request(app)
        .post('/api/_csrf_probe')
        .set('Cookie', [`token=${token}`, 'csrf=abc123'])
        .set('x-csrf-token', 'abc123');
      // CSRF OK => sigue al router; la ruta no existe => 404 (lo importante: NO 403).
      expect(res.status).not.toBe(403);
    });

    it('403 si el header no coincide con la cookie', async () => {
      const token = makeJWT(makeUser());
      const res = await request(app)
        .post('/api/_csrf_probe')
        .set('Cookie', [`token=${token}`, 'csrf=abc123'])
        .set('x-csrf-token', 'otro-valor');
      expect(res.status).toBe(403);
    });

    it('no aplica CSRF a requests por Bearer (sin cookie token)', async () => {
      const token = makeJWT(makeUser());
      const res = await request(app)
        .post('/api/_csrf_probe')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).not.toBe(403);
    });

    it('no aplica CSRF a /login ni /logout (exentas)', async () => {
      const token = makeJWT(makeUser());
      const rLogout = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`token=${token}`]);
      expect(rLogout.status).toBe(200);
    });
  });
});
