// tests/vencimientos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser, makeVencimiento } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
// authenticate hace lookup de activo en DB (S1); acá se mockea siempre-activo
// para no interferir con la cola del supabaseMock de cada test.
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));

import { createApp } from '../src/app';

describe('vencimientos', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const contadorB = makeUser({ id: 'contadorB', role: 'contador', estudio_id: 'estudio-B' });
  const admin = makeUser({ role: 'admin' });
  const clienteA = makeUser({ id: 'cliente-A', role: 'cliente', estudio_id: 'estudio-A' });

  const authA = bearerFor(contadorA);
  const authB = bearerFor(contadorB);
  const adminAuth = bearerFor(admin);
  const clienteAuth = bearerFor(clienteA);

  const validEntry = {
    obligacion: 'iva',
    terminacion_cuit: 3,
    anio: 2026,
    mes: 6,
    fecha_vencimiento: '2026-06-18',
  };

  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  describe('auth gate', () => {
    it('GET 401 sin token', async () => {
      const res = await request(app).get('/api/vencimientos');
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('GET 403 si role=admin', async () => {
      const res = await request(app).get('/api/vencimientos').set('Authorization', adminAuth);
      expect(res.status).toBe(403);
    });

    it('GET 403 si role=cliente', async () => {
      const res = await request(app).get('/api/vencimientos').set('Authorization', clienteAuth);
      expect(res.status).toBe(403);
    });

    it('PUT 403 si role=cliente', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', clienteAuth)
        .send({ entries: [validEntry] });
      expect(res.status).toBe(403);
    });

    it('DELETE 401 sin token', async () => {
      const res = await request(app).delete('/api/vencimientos/x');
      expect(res.status).toBe(401);
    });

    it('DELETE 403 si role=admin', async () => {
      const res = await request(app).delete('/api/vencimientos/x').set('Authorization', adminAuth);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/vencimientos', () => {
    it('200 lista filtrada por estudio_id del JWT', async () => {
      const lista = [makeVencimiento({ estudio_id: 'estudio-A' })];
      sb.queue([{ table: 'vencimientos', result: { data: lista, error: null } }]);
      const res = await request(app).get('/api/vencimientos').set('Authorization', authA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(lista);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });

    it('sin query anio → usa el año actual', async () => {
      const year = new Date().getFullYear();
      sb.queue([{ table: 'vencimientos', result: { data: [], error: null } }]);
      await request(app).get('/api/vencimientos').set('Authorization', authA);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'anio', year]);
    });

    it('200 con anio explícito', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: [], error: null } }]);
      await request(app).get('/api/vencimientos').query({ anio: 2027 }).set('Authorization', authA);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'anio', 2027]);
    });

    it('200 con filter obligacion', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: [], error: null } }]);
      await request(app)
        .get('/api/vencimientos')
        .query({ obligacion: 'monotributo' })
        .set('Authorization', authA);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'obligacion', 'monotributo']);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await request(app)
        .get('/api/vencimientos')
        .query({ anio: 2023 })
        .set('Authorization', authA);
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si obligacion inválida', async () => {
      const res = await request(app)
        .get('/api/vencimientos')
        .query({ obligacion: 'ganancias' })
        .set('Authorization', authA);
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('500 si la DB da error', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await request(app).get('/api/vencimientos').set('Authorization', authA);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Error interno del servidor' });
    });

    it('cross-estudio: contador B nunca ve el calendario de A (filtra por su estudio)', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: [], error: null } }]);
      await request(app).get('/api/vencimientos').set('Authorization', authB);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });
  });

  describe('PUT /api/vencimientos (reemplazo declarativo por año)', () => {
    // Helper: queue del select de filas existentes del año (paso 2 del replace).
    const existentesCall = (data: unknown[] = []) =>
      ({ table: 'vencimientos', result: { data, error: null } }) as const;

    it('400 si falta anio en el body', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ entries: [validEntry] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/anio debe ser un entero/);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio del body fuera de rango', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2023, entries: [] });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si entries no es array', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: 'nope' });
      expect(res.status).toBe(400);
    });

    it('entries [] limpia el año completo (borra todo lo existente)', async () => {
      sb.queue([
        existentesCall([
          { id: 'v1', obligacion: 'iva', terminacion_cuit: 3, mes: 6 },
          { id: 'v2', obligacion: 'monotributo', terminacion_cuit: null, mes: 7 },
        ]),
        { table: 'vencimientos', result: { data: null, error: null } }, // delete
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 0, deleted: 2, data: [] });
      // sin entries no hay upsert: el primer from es el select de existentes
      expect(sb.calls[0].op).toBe('select');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'anio', 2026]);
      expect(sb.calls[1].op).toBe('delete');
      expect(sb.calls[1].filters).toContainEqual(['in', 'id', ['v1', 'v2']]);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });

    it('400 si supera el máximo (>500)', async () => {
      const entries = Array.from({ length: 501 }, () => ({ ...validEntry }));
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si obligacion fuera del enum', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, obligacion: 'ganancias' }] });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si terminacion_cuit = 10', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, terminacion_cuit: 10 }] });
      expect(res.status).toBe(400);
    });

    it('400 si terminacion_cuit = -1', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, terminacion_cuit: -1 }] });
      expect(res.status).toBe(400);
    });

    it('400 si mes = 13', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, mes: 13 }] });
      expect(res.status).toBe(400);
    });

    it('400 si entry.anio fuera de rango', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, anio: 2101 }] });
      expect(res.status).toBe(400);
    });

    it('400 si entry.anio no coincide con anio del body', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2027, entries: [{ ...validEntry, anio: 2026 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/debe coincidir con anio del body/);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si fecha mal formada', async () => {
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, fecha_vencimiento: '18/06/2026' }] });
      expect(res.status).toBe(400);
    });

    it('estudio_id SIEMPRE del JWT (ignora el inyectado en el body)', async () => {
      const out = makeVencimiento({ estudio_id: 'estudio-A' });
      sb.queue([
        { table: 'vencimientos', result: { data: [out], error: null } }, // upsert
        existentesCall(),
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [{ ...validEntry, estudio_id: 'estudio-B' }] });

      expect(res.status).toBe(200);
      const upsertCall = sb.calls[0];
      expect(upsertCall.op).toBe('upsert');
      expect(upsertCall.payload).toHaveLength(1);
      expect(upsertCall.payload[0].estudio_id).toBe('estudio-A');
      expect(upsertCall.payload[0]).not.toMatchObject({ estudio_id: 'estudio-B' });
    });

    it('dedup interno: dos entries con misma clave → 1 sola fila, se conserva la última', async () => {
      sb.queue([
        { table: 'vencimientos', result: { data: [], error: null } }, // upsert
        existentesCall(),
      ]);
      await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({
          anio: 2026,
          entries: [
            { obligacion: 'iva', terminacion_cuit: 3, anio: 2026, mes: 6, fecha_vencimiento: '2026-06-18' },
            { obligacion: 'iva', terminacion_cuit: 3, anio: 2026, mes: 6, fecha_vencimiento: '2026-06-20' },
          ],
        });

      const payload = sb.calls[0].payload;
      expect(payload).toHaveLength(1);
      expect(payload[0].fecha_vencimiento).toBe('2026-06-20');
    });

    it('terminacion_cuit = null (monotributo) se upsertea OK', async () => {
      const out = makeVencimiento({ obligacion: 'monotributo', terminacion_cuit: null });
      sb.queue([
        { table: 'vencimientos', result: { data: [out], error: null } }, // upsert
        existentesCall(),
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({
          anio: 2026,
          entries: [{ obligacion: 'monotributo', terminacion_cuit: null, anio: 2026, mes: 6, fecha_vencimiento: '2026-06-20' }],
        });

      expect(res.status).toBe(200);
      expect(sb.calls[0].payload[0].terminacion_cuit).toBeNull();
    });

    it('happy: upsert con onConflict + borra filas del año no declaradas, responde { count, deleted, data }', async () => {
      const out = [makeVencimiento({ estudio_id: 'estudio-A', terminacion_cuit: 3 })];
      sb.queue([
        { table: 'vencimientos', result: { data: out, error: null } }, // upsert
        existentesCall([
          // la declarada (queda) + una vieja de otra celda (se borra)
          { id: 'v-keep', obligacion: 'iva', terminacion_cuit: 3, mes: 6 },
          { id: 'v-stale', obligacion: 'iva', terminacion_cuit: 7, mes: 6 },
        ]),
        { table: 'vencimientos', result: { data: null, error: null } }, // delete
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [validEntry] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 1, deleted: 1, data: out });

      const upsertCall = sb.calls[0];
      expect(upsertCall.op).toBe('upsert');
      expect(upsertCall.onConflict).toBe('estudio_id, obligacion, terminacion_cuit, anio, mes');
      expect(upsertCall.payload[0]).toMatchObject({
        estudio_id: 'estudio-A',
        obligacion: 'iva',
        terminacion_cuit: 3,
        anio: 2026,
        mes: 6,
        fecha_vencimiento: '2026-06-18',
      });

      const deleteCall = sb.calls[2];
      expect(deleteCall.op).toBe('delete');
      expect(deleteCall.filters).toContainEqual(['in', 'id', ['v-stale']]);
    });

    it('no emite delete si no hay filas stale', async () => {
      const out = [makeVencimiento({ estudio_id: 'estudio-A', terminacion_cuit: 3 })];
      sb.queue([
        { table: 'vencimientos', result: { data: out, error: null } }, // upsert
        existentesCall([{ id: 'v-keep', obligacion: 'iva', terminacion_cuit: 3, mes: 6 }]),
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [validEntry] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 1, deleted: 0, data: out });
      expect(sb.calls).toHaveLength(2); // upsert + select, sin delete
    });

    it('500 si el upsert da error', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [validEntry] });
      expect(res.status).toBe(500);
    });

    it('500 si el select de existentes da error', async () => {
      sb.queue([
        { table: 'vencimientos', result: { data: [], error: null } }, // upsert
        { table: 'vencimientos', result: { data: null, error: { message: 'boom' } } },
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [validEntry] });
      expect(res.status).toBe(500);
    });

    it('500 si el delete da error', async () => {
      sb.queue([
        { table: 'vencimientos', result: { data: [], error: null } }, // upsert
        existentesCall([{ id: 'v-stale', obligacion: 'iva', terminacion_cuit: 7, mes: 6 }]),
        { table: 'vencimientos', result: { data: null, error: { message: 'boom' } } },
      ]);
      const res = await request(app)
        .put('/api/vencimientos')
        .set('Authorization', authA)
        .send({ anio: 2026, entries: [validEntry] });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /api/vencimientos/:id', () => {
    it('404 si inexistente', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: [], error: null } }]);
      const res = await request(app).delete('/api/vencimientos/x').set('Authorization', authA);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Vencimiento no encontrado' });
    });

    it('404 cross-estudio (id de otro estudio → no matchea por eq estudio_id)', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: [], error: null } }]);
      const res = await request(app).delete('/api/vencimientos/de-A').set('Authorization', authB);
      expect(res.status).toBe(404);
      expect(sb.calls[0].op).toBe('delete');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('204 sin body al borrar OK + filtra por estudio_id del JWT', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: [{ id: 'v1' }], error: null } }]);
      const res = await request(app).delete('/api/vencimientos/v1').set('Authorization', authA);
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(sb.calls[0].op).toBe('delete');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'id', 'v1']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });

    it('500 si la DB da error', async () => {
      sb.queue([{ table: 'vencimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await request(app).delete('/api/vencimientos/v1').set('Authorization', authA);
      expect(res.status).toBe(500);
    });
  });
});
