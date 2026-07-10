// tests/comprobantes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));

import { createApp } from '../src/app';

describe('comprobantes + flag por estudio', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const clienteA = makeUser({ id: 'cliente-A', role: 'cliente', estudio_id: 'estudio-A' });
  const admin = makeUser({ id: 'admin-1', role: 'admin' });

  const authA = bearerFor(contadorA);
  const clienteAuth = bearerFor(clienteA);
  const adminAuth = bearerFor(admin);

  const jpg = () => Buffer.from('fake-image');

  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  describe('POST /api/impuestos/mis-impuestos/:id/comprobante', () => {
    it('401 sin token', async () => {
      const res = await request(app).post('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante');
      expect(res.status).toBe(401);
    });

    it('403 si role=contador', async () => {
      const res = await request(app)
        .post('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', authA);
      expect(res.status).toBe(403);
    });

    it('403 si el estudio tiene la feature deshabilitada', async () => {
      sb.queue([
        { table: 'estudios', result: { data: { comprobantes_habilitados: false }, error: null } },
      ]);
      const res = await request(app)
        .post('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', clienteAuth)
        .attach('archivo', jpg(), { filename: 'f.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/habilitada/i);
    });

    it('400 si falta el archivo', async () => {
      sb.queue([
        { table: 'estudios', result: { data: { comprobantes_habilitados: true }, error: null } },
      ]);
      const res = await request(app)
        .post('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/archivo/i);
    });

    it('400 si el mime no es imagen ni pdf', async () => {
      sb.queue([
        { table: 'estudios', result: { data: { comprobantes_habilitados: true }, error: null } },
      ]);
      const res = await request(app)
        .post('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', clienteAuth)
        .attach('archivo', Buffer.from('texto'), { filename: 'f.txt', contentType: 'text/plain' });
      expect(res.status).toBe(400);
    });

    it('404 si el impuesto no es del cliente', async () => {
      sb.queue([
        { table: 'estudios', result: { data: { comprobantes_habilitados: true }, error: null } },
        { table: 'impuestos', result: { data: null, error: null } },
      ]);
      const res = await request(app)
        .post('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', clienteAuth)
        .attach('archivo', jpg(), { filename: 'f.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET comprobante (404 cuando no hay)', () => {
    it('cliente — 404 sin comprobante', async () => {
      sb.queue([{ table: 'comprobantes_pago', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(404);
    });

    it('contador — 404 sin comprobante', async () => {
      sb.queue([{ table: 'comprobantes_pago', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/00000000-0000-4000-8000-000000000000/comprobante')
        .set('Authorization', authA);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/config', () => {
    it('401 sin token', async () => {
      const res = await request(app).get('/api/config');
      expect(res.status).toBe(401);
    });

    it('devuelve el flag del estudio', async () => {
      sb.queue([
        { table: 'estudios', result: { data: { comprobantes_habilitados: true }, error: null } },
      ]);
      const res = await request(app).get('/api/config').set('Authorization', clienteAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ comprobantes_habilitados: true });
    });
  });

  describe('PATCH /api/admin/estudios/:id/comprobantes', () => {
    it('403 si role=contador', async () => {
      const res = await request(app)
        .patch('/api/admin/estudios/00000000-0000-4000-8000-000000000000/comprobantes')
        .set('Authorization', authA)
        .send({ habilitado: true });
      expect(res.status).toBe(403);
    });

    it('400 si habilitado no es boolean', async () => {
      const res = await request(app)
        .patch('/api/admin/estudios/00000000-0000-4000-8000-000000000000/comprobantes')
        .set('Authorization', adminAuth)
        .send({ habilitado: 'si' });
      expect(res.status).toBe(400);
    });

    it('404 si el estudio no existe', async () => {
      sb.queue([{ table: 'estudios', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/admin/estudios/11111111-1111-4111-8111-111111111111/comprobantes')
        .set('Authorization', adminAuth)
        .send({ habilitado: true });
      expect(res.status).toBe(404);
    });

    it('200 actualiza el flag', async () => {
      const updated = {
        id: 'estudio-A',
        nombre: 'Estudio A',
        activo: true,
        comprobantes_habilitados: true,
        created_at: '2026-01-01',
      };
      sb.queue([{ table: 'estudios', result: { data: updated, error: null } }]);
      const res = await request(app)
        .patch('/api/admin/estudios/00000000-0000-4000-8000-000000000000/comprobantes')
        .set('Authorization', adminAuth)
        .send({ habilitado: true });
      expect(res.status).toBe(200);
      expect(res.body.comprobantes_habilitados).toBe(true);
      expect(sb.calls[0].op).toBe('update');
      expect(sb.calls[0].payload).toEqual({ comprobantes_habilitados: true });
    });
  });
});
