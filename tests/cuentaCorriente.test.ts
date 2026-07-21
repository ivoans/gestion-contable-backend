// tests/cuentaCorriente.test.ts — estado de cuenta unificado (impuestos + honorarios),
// aging por antigüedad, dashboard global de cobranzas y PDF al vuelo.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';
import { getDateAR, addDays } from '../src/utils/fechas';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

const { descargarComprobante } = vi.hoisted(() => ({
  descargarComprobante: vi.fn(async () => null),
}));

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/lib/storage', () => ({ descargarComprobante }));
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));

import { createApp } from '../src/app';

const contador = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
const cliente = makeUser({ role: 'cliente', estudio_id: 'estudio-1' });
const authC = () => bearerFor(contador);
const authCli = () => bearerFor(cliente);

const HOY = getDateAR();

function imp(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000i1',
    tipo: 'IVA',
    fecha_vencimiento: addDays(HOY, -5),
    monto: 45000,
    estado: 'vencido',
    ...overrides,
  };
}

function hon(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000h1',
    periodo: '2026-06-01',
    descripcion: null,
    fecha_vencimiento: addDays(HOY, -5),
    monto: 30000,
    estado: 'vencido',
    ...overrides,
  };
}

const app = createApp();

beforeEach(() => {
  sb.reset();
  descargarComprobante.mockClear();
});

describe('GET /api/cuenta-corriente/mio (cliente)', () => {
  it('arma bloques Impuestos + Estudio con subtotales y total', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [imp({ monto: 45000 }), imp({ id: 'x', tipo: 'Autónomos', monto: 12000, estado: 'pendiente' })], error: null } },
      { table: 'honorarios', result: { data: [hon({ monto: 30000 })], error: null } },
    ]);

    const res = await request(app).get('/api/cuenta-corriente/mio').set('Authorization', authCli());

    expect(res.status).toBe(200);
    expect(res.body.impuestos.subtotal).toBe(57000);
    expect(res.body.estudio.subtotal).toBe(30000);
    expect(res.body.total).toBe(87000);
    expect(res.body.impuestos.items[0]).toMatchObject({ origen: 'impuesto', concepto: 'IVA' });
    // Multi-tenant + filtro de outstanding a nivel query.
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
    expect(sb.calls[0].filters).toContainEqual(['in', 'estado', ['pendiente', 'vencido']]);
    expect(sb.calls[1].filters).toContainEqual(['in', 'estado', ['pendiente', 'vencido']]);
  });

  it('honorario suelto (periodo null) usa la descripción como concepto', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [], error: null } },
      { table: 'honorarios', result: { data: [hon({ periodo: null, descripcion: 'Manifestación de bienes', monto: 18000 })], error: null } },
    ]);

    const res = await request(app).get('/api/cuenta-corriente/mio').set('Authorization', authCli());

    expect(res.status).toBe(200);
    expect(res.body.estudio.items[0].concepto).toBe('Manifestación de bienes');
    expect(res.body.estudio.items[0].origen).toBe('honorario');
    expect(res.body.total).toBe(18000);
  });

  it('honorario con período arma "Honorarios <mes año>"', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [], error: null } },
      { table: 'honorarios', result: { data: [hon({ periodo: '2026-06-01', descripcion: null })], error: null } },
    ]);

    const res = await request(app).get('/api/cuenta-corriente/mio').set('Authorization', authCli());

    expect(res.body.estudio.items[0].concepto).toBe('Honorarios junio 2026');
  });

  it('bloques vacíos → total 0 y aging en cero', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [], error: null } },
      { table: 'honorarios', result: { data: [], error: null } },
    ]);

    const res = await request(app).get('/api/cuenta-corriente/mio').set('Authorization', authCli());

    expect(res.body.total).toBe(0);
    expect(res.body.aging).toEqual({ por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_mas: 0 });
  });

  it('500 si la DB falla', async () => {
    sb.queue([{ table: 'impuestos', result: { data: null, error: { message: 'boom' } } }]);
    const res = await request(app).get('/api/cuenta-corriente/mio').set('Authorization', authCli());
    expect(res.status).toBe(500);
  });
});

describe('aging (solo honorarios)', () => {
  it('clasifica cada honorario en su bucket por antigüedad', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [], error: null } },
      {
        table: 'honorarios',
        result: {
          data: [
            hon({ id: 'a', fecha_vencimiento: addDays(HOY, 10), monto: 100 }), // por vencer
            hon({ id: 'b', fecha_vencimiento: addDays(HOY, -15), monto: 200 }), // 0-30
            hon({ id: 'c', fecha_vencimiento: addDays(HOY, -45), monto: 400 }), // 31-60
            hon({ id: 'd', fecha_vencimiento: addDays(HOY, -75), monto: 800 }), // 61-90
            hon({ id: 'e', fecha_vencimiento: addDays(HOY, -120), monto: 1600 }), // +90
          ],
          error: null,
        },
      },
    ]);

    const res = await request(app).get('/api/cuenta-corriente/mio').set('Authorization', authCli());

    expect(res.body.aging).toEqual({
      por_vencer: 100,
      d0_30: 200,
      d31_60: 400,
      d61_90: 800,
      d90_mas: 1600,
    });
  });
});

describe('GET /api/cuenta-corriente?cliente_id= (contador)', () => {
  it('400 sin cliente_id', async () => {
    const res = await request(app).get('/api/cuenta-corriente').set('Authorization', authC());
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si cliente_id no es uuid', async () => {
    const res = await request(app).get('/api/cuenta-corriente?cliente_id=abc').set('Authorization', authC());
    expect(res.status).toBe(400);
  });

  it('200 con cliente_id válido', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [imp()], error: null } },
      { table: 'honorarios', result: { data: [hon()], error: null } },
    ]);
    const res = await request(app)
      .get(`/api/cuenta-corriente?cliente_id=${cliente.id}`)
      .set('Authorization', authC());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(75000);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
  });

  it('403 si un cliente intenta la ruta del contador', async () => {
    const res = await request(app)
      .get(`/api/cuenta-corriente?cliente_id=${cliente.id}`)
      .set('Authorization', authCli());
    expect(res.status).toBe(403);
  });
});

describe('GET /api/cobranzas (contador)', () => {
  it('agrupa por cliente, ordena por saldo desc y arma aging', async () => {
    sb.queue([
      {
        table: 'honorarios',
        result: {
          data: [
            { cliente_id: 'c1', monto: 18000, fecha_vencimiento: addDays(HOY, -10), estado: 'vencido', cliente: { id: 'c1', nombre: 'Juan', telefono: '2954111' } },
            { cliente_id: 'c1', monto: 30000, fecha_vencimiento: addDays(HOY, -45), estado: 'vencido', cliente: { id: 'c1', nombre: 'Juan', telefono: '2954111' } },
            { cliente_id: 'c2', monto: 22000, fecha_vencimiento: addDays(HOY, -45), estado: 'vencido', cliente: { id: 'c2', nombre: 'María', telefono: null } },
          ],
          error: null,
        },
      },
    ]);

    const res = await request(app).get('/api/cobranzas').set('Authorization', authC());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Ordenado por saldo desc: Juan (48000) antes que María (22000).
    expect(res.body[0]).toMatchObject({ cliente_id: 'c1', nombre: 'Juan', saldo: 48000 });
    expect(res.body[0].aging).toEqual({ por_vencer: 0, d0_30: 18000, d31_60: 30000, d61_90: 0, d90_mas: 0 });
    expect(res.body[1]).toMatchObject({ cliente_id: 'c2', saldo: 22000 });
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
  });

  it('403 si un cliente intenta ver cobranzas', async () => {
    const res = await request(app).get('/api/cobranzas').set('Authorization', authCli());
    expect(res.status).toBe(403);
  });
});

describe('PDF al vuelo', () => {
  it('GET /api/cuenta-corriente/mio/pdf → application/pdf', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [imp()], error: null } },
      { table: 'honorarios', result: { data: [hon()], error: null } },
      { table: 'estudios', result: { data: { nombre: 'Estudio ST', domicilio: 'Calle 1', cuit: '20111111112', telefono: '2954', email: 'e@t.local', condicion_iva: 'MONOTRIBUTO', logo_path: null }, error: null } },
      { table: 'users', result: { data: { nombre: 'Juan', domicilio: 'Dom 1', cuit: '20999', telefono: '2954', email: 'j@t.local', condicion_fiscal: 'monotributista' }, error: null } },
    ]);

    const res = await request(app).get('/api/cuenta-corriente/mio/pdf').set('Authorization', authCli());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.length).toBeGreaterThan(500);
  });

  it('404 si el cliente no existe en el estudio', async () => {
    sb.queue([
      { table: 'impuestos', result: { data: [], error: null } },
      { table: 'honorarios', result: { data: [], error: null } },
      { table: 'estudios', result: { data: { nombre: 'Estudio ST', domicilio: null, cuit: null, telefono: null, email: null, condicion_iva: null, logo_path: null }, error: null } },
      { table: 'users', result: { data: null, error: null } },
    ]);

    const res = await request(app)
      .get(`/api/cuenta-corriente/pdf?cliente_id=${cliente.id}`)
      .set('Authorization', authC());

    expect(res.status).toBe(404);
  });
});
