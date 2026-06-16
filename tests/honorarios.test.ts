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

const contador = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
const cliente = makeUser({ role: 'cliente', estudio_id: 'estudio-1' });
const authC = () => bearerFor(contador);
const authCli = () => bearerFor(cliente);

function makeHonorario(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hon-1',
    estudio_id: 'estudio-1',
    cliente_id: cliente.id,
    creado_por: contador.id,
    periodo: '2026-06-01',
    monto: 50000,
    fecha_vencimiento: '2026-06-10',
    descripcion: 'Honorarios Junio 2026',
    estado: 'pendiente',
    pagado_at: null,
    pagado_por: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('Honorarios — contador', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  it('GET /api/honorarios lista del estudio', async () => {
    sb.queue([{ table: 'honorarios', result: { data: [makeHonorario()], error: null } }]);
    const res = await request(app).get('/api/honorarios').set('Authorization', authC());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
  });

  it('GET /api/honorarios 400 si estado inválido', async () => {
    const res = await request(app)
      .get('/api/honorarios?estado=cualquiera')
      .set('Authorization', authC());
    expect(res.status).toBe(400);
  });

  it('GET /api/honorarios 403 si es cliente', async () => {
    const res = await request(app).get('/api/honorarios').set('Authorization', authCli());
    expect(res.status).toBe(403);
  });

  it('GET /api/honorarios/resumen agrupa por estado', async () => {
    sb.queue([
      {
        table: 'honorarios',
        result: {
          data: [
            { estado: 'pendiente', monto: 100 },
            { estado: 'pendiente', monto: 50 },
            { estado: 'vencido', monto: 200 },
            { estado: 'pagado', monto: 300 },
            { estado: 'anulado', monto: 999 },
          ],
          error: null,
        },
      },
    ]);
    const res = await request(app).get('/api/honorarios/resumen').set('Authorization', authC());
    expect(res.status).toBe(200);
    expect(res.body.pendiente).toEqual({ count: 2, monto: 150 });
    expect(res.body.vencido).toEqual({ count: 1, monto: 200 });
    expect(res.body.pagado).toEqual({ count: 1, monto: 300 });
  });

  it('POST /api/honorarios/generar genera del plan (idempotente)', async () => {
    sb.queue([
      {
        table: 'honorarios_plan',
        result: {
          data: [
            { cliente_id: 'c1', estudio_id: 'estudio-1', monto: 50000, dia_vencimiento: 10, cliente: { activo: true } },
            { cliente_id: 'c2', estudio_id: 'estudio-1', monto: 70000, dia_vencimiento: 5, cliente: { activo: true } },
          ],
          error: null,
        },
      },
      { table: 'honorarios', result: { data: [{ id: 'h1' }], error: null } },
      // revivirAnulados: select de anulados del período (ninguno).
      { table: 'honorarios', result: { data: [], error: null } },
    ]);
    const res = await request(app)
      .post('/api/honorarios/generar')
      .set('Authorization', authC())
      .send({ anio: 2026, mes: 6 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ anio: 2026, mes: 6, creados: 1, ya_existentes: 1, reactivados: 0 });
    // El upsert usa el índice anti-duplicado.
    const upsertCall = sb.calls.find((c) => c.op === 'upsert');
    expect(upsertCall?.onConflict).toBe('cliente_id, periodo');
    expect(upsertCall?.ignoreDuplicates).toBe(true);
  });

  it('POST /api/honorarios/generar revive un honorario anulado del período', async () => {
    sb.queue([
      {
        table: 'honorarios_plan',
        result: {
          data: [
            { cliente_id: 'c1', estudio_id: 'estudio-1', monto: 50000, dia_vencimiento: 10, cliente: { activo: true } },
          ],
          error: null,
        },
      },
      // upsert: ya existía (anulado) → 0 insertados.
      { table: 'honorarios', result: { data: [], error: null } },
      // revivirAnulados: select encuentra el anulado de c1.
      { table: 'honorarios', result: { data: [{ id: 'h-anul', cliente_id: 'c1' }], error: null } },
      // revivirAnulados: update del anulado a pendiente.
      { table: 'honorarios', result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .post('/api/honorarios/generar')
      .set('Authorization', authC())
      .send({ anio: 2026, mes: 6 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ creados: 0, ya_existentes: 0, reactivados: 1 });
    // El update llevó el anulado a 'pendiente'.
    const updCall = sb.calls.find((c) => c.op === 'update');
    expect(updCall?.payload).toMatchObject({ estado: 'pendiente', monto: 50000 });
    expect(updCall?.filters).toContainEqual(['eq', 'id', 'h-anul']);
  });

  it('PATCH /api/honorarios/:id edita monto', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'hon-1', estado: 'pendiente' }, error: null }, result: { data: null, error: null } },
      { table: 'honorarios', resultSingle: { data: makeHonorario({ monto: 60000 }), error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/hon-1')
      .set('Authorization', authC())
      .send({ monto: 60000 });
    expect(res.status).toBe(200);
    expect(res.body.monto).toBe(60000);
  });

  it('PATCH /api/honorarios/:id 400 si está pagado', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'hon-1', estado: 'pagado' }, error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/hon-1')
      .set('Authorization', authC())
      .send({ monto: 60000 });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/honorarios/:id 400 sin campos', async () => {
    const res = await request(app)
      .patch('/api/honorarios/hon-1')
      .set('Authorization', authC())
      .send({});
    expect(res.status).toBe(400);
  });

  it('PATCH /api/honorarios/:id/estado marca pagado', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'hon-1', estado: 'pendiente' }, error: null }, result: { data: null, error: null } },
      { table: 'honorarios', resultSingle: { data: makeHonorario({ estado: 'pagado', pagado_at: 'x', pagado_por: contador.id }), error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/hon-1/estado')
      .set('Authorization', authC());
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('pagado');
  });

  it('PATCH /api/honorarios/:id/revertir 400 si no está pagado', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'hon-1', estado: 'pendiente', fecha_vencimiento: '2026-06-10' }, error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/hon-1/revertir')
      .set('Authorization', authC());
    expect(res.status).toBe(400);
  });

  it('PATCH /api/honorarios/:id/anular 400 si está pagado', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'hon-1', estado: 'pagado' }, error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/hon-1/anular')
      .set('Authorization', authC());
    expect(res.status).toBe(400);
  });
});

describe('Honorarios — planes', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  it('GET /api/honorarios/planes lista', async () => {
    sb.queue([{ table: 'honorarios_plan', result: { data: [], error: null } }]);
    const res = await request(app).get('/api/honorarios/planes').set('Authorization', authC());
    expect(res.status).toBe(200);
  });

  it('PUT /api/honorarios/planes/:clienteId crea/edita', async () => {
    sb.queue([
      { table: 'users', resultMaybeSingle: { data: { id: cliente.id }, error: null }, result: { data: null, error: null } },
      { table: 'honorarios_plan', resultSingle: { data: { id: 'plan-1', estudio_id: 'estudio-1', cliente_id: cliente.id, monto: 50000, dia_vencimiento: 10, activo: true }, error: null }, result: { data: null, error: null } },
      // Al guardar el plan activo se genera el honorario del mes actual (upsert idempotente).
      { table: 'honorarios', result: { data: [{ id: 'h-gen' }], error: null } },
      // revivirAnulados: select de anulados de ese cliente (ninguno).
      { table: 'honorarios', result: { data: [], error: null } },
    ]);
    const res = await request(app)
      .put(`/api/honorarios/planes/${cliente.id}`)
      .set('Authorization', authC())
      .send({ monto: 50000, dia_vencimiento: 10 });
    expect(res.status).toBe(200);
    expect(res.body.monto).toBe(50000);
    const planUpsert = sb.calls.find((c) => c.table === 'honorarios_plan' && c.op === 'upsert');
    expect(planUpsert?.onConflict).toBe('cliente_id');
    // Se generó el honorario del mes para ese cliente.
    const honUpsert = sb.calls.find((c) => c.table === 'honorarios' && c.op === 'upsert');
    expect(honUpsert?.onConflict).toBe('cliente_id, periodo');
  });

  it('PUT /api/honorarios/planes/:clienteId 404 si cliente no existe', async () => {
    sb.queue([
      { table: 'users', resultMaybeSingle: { data: null, error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .put('/api/honorarios/planes/desconocido')
      .set('Authorization', authC())
      .send({ monto: 50000 });
    expect(res.status).toBe(404);
  });

  it('PUT /api/honorarios/planes/:clienteId 400 si monto inválido', async () => {
    const res = await request(app)
      .put(`/api/honorarios/planes/${cliente.id}`)
      .set('Authorization', authC())
      .send({ monto: -5 });
    expect(res.status).toBe(400);
  });
});

describe('Honorarios — cliente', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  it('GET /api/honorarios/mis-honorarios agrupa', async () => {
    sb.queue([
      {
        table: 'honorarios',
        result: {
          data: [
            makeHonorario({ id: 'h1', estado: 'pendiente' }),
            makeHonorario({ id: 'h2', estado: 'vencido' }),
            makeHonorario({ id: 'h3', estado: 'pagado', pagado_at: 'x', pagado_por: cliente.id }),
          ],
          error: null,
        },
      },
    ]);
    const res = await request(app)
      .get('/api/honorarios/mis-honorarios')
      .set('Authorization', authCli());
    expect(res.status).toBe(200);
    expect(res.body.pendientes).toHaveLength(1);
    expect(res.body.vencidos).toHaveLength(1);
    expect(res.body.pagados).toHaveLength(1);
    // El cliente filtra por su id y excluye anulados.
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
    expect(sb.calls[0].filters).toContainEqual(['neq', 'estado', 'anulado']);
  });

  it('GET /api/honorarios/mis-honorarios 403 si es contador', async () => {
    const res = await request(app)
      .get('/api/honorarios/mis-honorarios')
      .set('Authorization', authC());
    expect(res.status).toBe(403);
  });

  it('PATCH mis-honorarios/:id/estado marca pagado', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'h1', estado: 'pendiente' }, error: null }, result: { data: null, error: null } },
      { table: 'honorarios', resultSingle: { data: makeHonorario({ estado: 'pagado', pagado_at: 'x', pagado_por: cliente.id }), error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/mis-honorarios/h1/estado')
      .set('Authorization', authCli());
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('pagado');
  });

  it('PATCH mis-honorarios/:id/estado 404 si está anulado', async () => {
    sb.queue([
      { table: 'honorarios', resultMaybeSingle: { data: { id: 'h1', estado: 'anulado' }, error: null }, result: { data: null, error: null } },
    ]);
    const res = await request(app)
      .patch('/api/honorarios/mis-honorarios/h1/estado')
      .set('Authorization', authCli());
    expect(res.status).toBe(404);
  });
});
