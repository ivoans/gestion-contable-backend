// tests/recibos.test.ts — recibo de cobranza de honorarios (E7): emisión al confirmar
// cobro (numeración correlativa vía RPC + PDF a Storage), consulta contadora/cliente y
// borrado al revertir el cobro.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

const { subirComprobante, signedUrlComprobante, borrarComprobante, descargarComprobante } = vi.hoisted(() => ({
  subirComprobante: vi.fn(async () => undefined),
  signedUrlComprobante: vi.fn(async () => 'https://signed.example/recibo.pdf'),
  borrarComprobante: vi.fn(async () => undefined),
  descargarComprobante: vi.fn(async () => null),
}));

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/lib/storage', () => ({
  subirComprobante,
  signedUrlComprobante,
  borrarComprobante,
  descargarComprobante,
}));
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));

import { createApp } from '../src/app';

const contador = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
const cliente = makeUser({ role: 'cliente', estudio_id: 'estudio-1' });
const authC = () => bearerFor(contador);
const authCli = () => bearerFor(cliente);

const HON_ID = '00000000-0000-4000-8000-00000000aa01';

const honorarioPagado = {
  id: HON_ID,
  estudio_id: 'estudio-1',
  cliente_id: cliente.id,
  creado_por: contador.id,
  periodo: '2026-06-01',
  monto: 60000,
  fecha_vencimiento: '2026-07-10',
  descripcion: 'Honorarios Junio 2026',
  estado: 'pagado',
  pagado_at: '2026-07-12T00:00:00Z',
  pagado_por: contador.id,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-12T00:00:00Z',
};

const estudioCompleto = {
  id: 'estudio-1',
  nombre: 'Estudio Contable ST',
  domicilio: 'Garibaldi N° 639 - General Acha',
  cuit: '27399325957',
  telefono: '+542954679789',
  email: 'estudio@test.local',
  condicion_iva: 'MONOTRIBUTO',
  inicio_actividades: '2026-01-01',
  logo_path: null,
  recibo_punto_venta: 1,
};

const clienteRow = {
  nombre: 'BALLEJOS, ELSA',
  domicilio: 'Fraga 1282',
  cuit: '27261553762',
  telefono: '2954582835',
  email: 'cli@test.local',
  condicion_fiscal: 'monotributista',
};

const reciboRow = {
  id: 'rec-1',
  honorario_id: HON_ID,
  cliente_id: cliente.id,
  punto_venta: 1,
  numero: 7,
  fecha: '2026-07-15',
  metodo_pago: 'Efectivo',
  concepto: 'Honorarios Junio 2026',
  monto: 60000,
  storage_path: 'estudio-1/recibos/x.pdf',
  created_at: '2026-07-15T00:00:00Z',
};

beforeEach(() => {
  sb.reset();
  subirComprobante.mockClear();
  signedUrlComprobante.mockClear();
  borrarComprobante.mockClear();
  descargarComprobante.mockClear();
});

describe('POST /api/honorarios/:id/recibo — emisión', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  it('emite el recibo: RPC de numeración + PDF a Storage + fila en recibos', async () => {
    sb.queue([
      { table: 'honorarios', result: { data: honorarioPagado, error: null } },
      { table: 'recibos', result: { data: null, error: null } }, // no existía
      { table: 'estudios', result: { data: estudioCompleto, error: null } },
      { table: 'users', result: { data: clienteRow, error: null } },
      { table: 'recibos', resultSingle: { data: { ...reciboRow, numero: 1 }, error: null }, result: { data: null, error: null } },
    ]);
    sb.queueRpc([{ fn: 'next_numero_recibo', result: { data: 1, error: null } }]);

    const res = await request(app)
      .post(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC())
      .send({ metodo_pago: 'Efectivo' });

    expect(res.status).toBe(201);
    expect(res.body.numero_completo).toBe('00001-00000001');
    expect(res.body.url).toBe('https://signed.example/recibo.pdf');

    expect(sb.rpcCalls[0]).toEqual({ fn: 'next_numero_recibo', args: { p_estudio_id: 'estudio-1' } });
    expect(subirComprobante).toHaveBeenCalledTimes(1);
    const [path, buffer, mime] = subirComprobante.mock.calls[0] as unknown as [string, Buffer, string];
    expect(path).toContain('estudio-1/recibos/');
    expect(mime).toBe('application/pdf');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-'); // PDF real, no placeholder

    const ins = sb.calls.find((c) => c.table === 'recibos' && c.op === 'insert');
    expect(ins?.payload).toMatchObject({
      honorario_id: HON_ID,
      cliente_id: cliente.id,
      punto_venta: 1,
      numero: 1,
      metodo_pago: 'Efectivo',
      concepto: 'Honorarios Junio 2026',
      monto: 60000,
      emitido_por: contador.id,
    });
  });

  it('idempotente: si ya hay recibo devuelve el existente sin consumir numeración', async () => {
    sb.queue([
      { table: 'honorarios', result: { data: honorarioPagado, error: null } },
      { table: 'recibos', result: { data: reciboRow, error: null } },
    ]);

    const res = await request(app)
      .post(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC())
      .send({ metodo_pago: 'Efectivo' });

    expect(res.status).toBe(200);
    expect(res.body.numero_completo).toBe('00001-00000007');
    expect(sb.rpcCalls).toHaveLength(0);
    expect(subirComprobante).not.toHaveBeenCalled();
  });

  it('400 si el honorario no está pagado', async () => {
    sb.queue([
      { table: 'honorarios', result: { data: { ...honorarioPagado, estado: 'pendiente', pagado_at: null, pagado_por: null }, error: null } },
    ]);
    const res = await request(app)
      .post(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC())
      .send({ metodo_pago: 'Efectivo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pagado/i);
  });

  it('400 si el estudio no tiene CUIT cargado', async () => {
    sb.queue([
      { table: 'honorarios', result: { data: honorarioPagado, error: null } },
      { table: 'recibos', result: { data: null, error: null } },
      { table: 'estudios', result: { data: { ...estudioCompleto, cuit: null }, error: null } },
    ]);
    const res = await request(app)
      .post(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC())
      .send({ metodo_pago: 'Efectivo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/datos fiscales/i);
  });

  it('400 sin metodo_pago', async () => {
    const res = await request(app)
      .post(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC())
      .send({});
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('403 si es cliente', async () => {
    const res = await request(app)
      .post(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authCli())
      .send({ metodo_pago: 'Efectivo' });
    expect(res.status).toBe(403);
  });
});

describe('GET recibo — contadora y cliente', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  it('GET /api/honorarios/:id/recibo devuelve metadata + url', async () => {
    sb.queue([{ table: 'recibos', result: { data: reciboRow, error: null } }]);
    const res = await request(app)
      .get(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC());
    expect(res.status).toBe(200);
    expect(res.body.numero_completo).toBe('00001-00000007');
    expect(res.body.url).toBe('https://signed.example/recibo.pdf');
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
  });

  it('GET /api/honorarios/:id/recibo 404 si no se emitió', async () => {
    sb.queue([{ table: 'recibos', result: { data: null, error: null } }]);
    const res = await request(app)
      .get(`/api/honorarios/${HON_ID}/recibo`)
      .set('Authorization', authC());
    expect(res.status).toBe(404);
  });

  it('GET /api/honorarios/mis-honorarios/:id/recibo filtra por cliente', async () => {
    sb.queue([{ table: 'recibos', result: { data: reciboRow, error: null } }]);
    const res = await request(app)
      .get(`/api/honorarios/mis-honorarios/${HON_ID}/recibo`)
      .set('Authorization', authCli());
    expect(res.status).toBe(200);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
  });
});

describe('PATCH /api/honorarios/:id/revertir — anula el recibo', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  it('borra la fila del recibo y su PDF antes de revertir el cobro', async () => {
    sb.queue([
      { table: 'honorarios', result: { data: { id: HON_ID, estado: 'pagado', fecha_vencimiento: '2026-07-10' }, error: null } },
      { table: 'recibos', result: { data: { id: 'rec-1', storage_path: 'estudio-1/recibos/x.pdf' }, error: null } },
      { table: 'recibos', result: { data: null, error: null } }, // delete
      { table: 'honorarios', resultSingle: { data: { ...honorarioPagado, estado: 'vencido', pagado_at: null, pagado_por: null }, error: null }, result: { data: null, error: null } },
    ]);

    const res = await request(app)
      .patch(`/api/honorarios/${HON_ID}/revertir`)
      .set('Authorization', authC());

    expect(res.status).toBe(200);
    const del = sb.calls.find((c) => c.table === 'recibos' && c.op === 'delete');
    expect(del?.filters).toContainEqual(['eq', 'id', 'rec-1']);
    expect(borrarComprobante).toHaveBeenCalledWith('estudio-1/recibos/x.pdf');
  });

  it('sin recibo emitido revierte igual (no llama a Storage)', async () => {
    sb.queue([
      { table: 'honorarios', result: { data: { id: HON_ID, estado: 'pagado', fecha_vencimiento: '2026-07-10' }, error: null } },
      { table: 'recibos', result: { data: null, error: null } },
      { table: 'honorarios', resultSingle: { data: { ...honorarioPagado, estado: 'vencido', pagado_at: null, pagado_por: null }, error: null }, result: { data: null, error: null } },
    ]);

    const res = await request(app)
      .patch(`/api/honorarios/${HON_ID}/revertir`)
      .set('Authorization', authC());

    expect(res.status).toBe(200);
    expect(borrarComprobante).not.toHaveBeenCalled();
  });
});
