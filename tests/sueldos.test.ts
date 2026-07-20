// tests/sueldos.test.ts — módulo SUELDOS (E3, Fase 4): la contadora carga recibos de
// sueldo por cliente (período + monto + empleado + PDF opcional); el cliente los ve en
// solo lectura. Gateado por empleadores_sicoss / casas_particulares.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

const { subirComprobante, signedUrlComprobante, borrarComprobante } = vi.hoisted(() => ({
  subirComprobante: vi.fn(async () => undefined),
  signedUrlComprobante: vi.fn(async () => 'https://signed.example/recibo-sueldo.pdf'),
  borrarComprobante: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/lib/storage', () => ({
  subirComprobante,
  signedUrlComprobante,
  borrarComprobante,
}));
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));

import { createApp } from '../src/app';

const contador = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
const cliente = makeUser({ role: 'cliente', estudio_id: 'estudio-1', empleadores_sicoss: true });
const authC = bearerFor(contador);
const authCli = bearerFor(cliente);

const CLIENTE_ID = '00000000-0000-4000-8000-0000000000c1';
const SUELDO_ID = '00000000-0000-4000-8000-0000000000a1';

const pdf = () => Buffer.from('%PDF-1.4 fake');

function sueldoRow(over: Record<string, unknown> = {}) {
  return {
    id: SUELDO_ID,
    estudio_id: 'estudio-1',
    cliente_id: CLIENTE_ID,
    empleado: 'Juan Perez',
    periodo: '2026-06-01',
    monto: 500000,
    storage_path: null,
    mime: null,
    size_bytes: null,
    original_name: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  sb.reset();
  subirComprobante.mockClear();
  signedUrlComprobante.mockClear();
  borrarComprobante.mockClear();
  app = createApp();
});

describe('sueldos — auth / roles', () => {
  it('401 sin token', async () => {
    const res = await request(app).post('/api/sueldos');
    expect(res.status).toBe(401);
  });

  it('403 si un cliente intenta crear', async () => {
    const res = await request(app).post('/api/sueldos').set('Authorization', authCli).send({});
    expect(res.status).toBe(403);
  });

  it('403 si un contador pega a /mios', async () => {
    const res = await request(app).get('/api/sueldos/mios').set('Authorization', authC);
    expect(res.status).toBe(403);
  });
});

describe('sueldos — POST (crear)', () => {
  it('400 si cliente_id no es uuid', async () => {
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: 'no-uuid', empleado: 'Juan', periodo: '2026-06', monto: '1000' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si empleado vacío', async () => {
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: CLIENTE_ID, empleado: '  ', periodo: '2026-06', monto: '1000' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si periodo inválido', async () => {
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: CLIENTE_ID, empleado: 'Juan', periodo: '2026/06', monto: '1000' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si monto inválido', async () => {
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: CLIENTE_ID, empleado: 'Juan', periodo: '2026-06', monto: 'abc' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('404 si el cliente no existe en el estudio', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: null } }]);
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: CLIENTE_ID, empleado: 'Juan', periodo: '2026-06', monto: '1000' });
    expect(res.status).toBe(404);
  });

  it('400 si el cliente no tiene empleados (sin flag)', async () => {
    sb.queue([
      { table: 'users', result: { data: { empleadores_sicoss: false, casas_particulares: false }, error: null } },
    ]);
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: CLIENTE_ID, empleado: 'Juan', periodo: '2026-06', monto: '1000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empleados/i);
  });

  it('201 sin archivo (normaliza periodo al día 1, no toca Storage)', async () => {
    sb.queue([
      { table: 'users', result: { data: { empleadores_sicoss: true, casas_particulares: false }, error: null } },
      { table: 'sueldos', result: { data: sueldoRow(), error: null } },
    ]);
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .send({ cliente_id: CLIENTE_ID, empleado: 'Juan Perez', periodo: '2026-06', monto: '500000' });
    expect(res.status).toBe(201);
    expect(subirComprobante).not.toHaveBeenCalled();
    const insert = sb.calls.find((c) => c.table === 'sueldos');
    expect(insert?.op).toBe('insert');
    expect(insert?.payload).toMatchObject({ periodo: '2026-06-01', monto: 500000, empleado: 'Juan Perez' });
  });

  it('201 con PDF adjunto (sube a Storage con path de sueldos)', async () => {
    sb.queue([
      { table: 'users', result: { data: { empleadores_sicoss: true, casas_particulares: false }, error: null } },
      { table: 'sueldos', result: { data: sueldoRow({ storage_path: 'p', mime: 'application/pdf' }), error: null } },
    ]);
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .field('cliente_id', CLIENTE_ID)
      .field('empleado', 'Juan Perez')
      .field('periodo', '2026-06')
      .field('monto', '500000')
      .attach('archivo', pdf(), { filename: 'recibo.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(subirComprobante).toHaveBeenCalledTimes(1);
    const path = subirComprobante.mock.calls[0][0] as string;
    expect(path).toMatch(new RegExp(`^estudio-1/sueldos/${CLIENTE_ID}/.*\\.pdf$`));
  });

  it('400 si el archivo no es imagen ni PDF', async () => {
    const res = await request(app)
      .post('/api/sueldos')
      .set('Authorization', authC)
      .field('cliente_id', CLIENTE_ID)
      .field('empleado', 'Juan')
      .field('periodo', '2026-06')
      .field('monto', '1000')
      .attach('archivo', Buffer.from('texto'), { filename: 'f.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });
});

describe('sueldos — listar / leer', () => {
  it('400 si falta cliente_id (contador)', async () => {
    const res = await request(app).get('/api/sueldos').set('Authorization', authC);
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('200 lista del cliente (contador)', async () => {
    sb.queue([{ table: 'sueldos', result: { data: [sueldoRow()], error: null } }]);
    const res = await request(app)
      .get('/api/sueldos')
      .query({ cliente_id: CLIENTE_ID })
      .set('Authorization', authC);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('200 /mios (cliente)', async () => {
    sb.queue([{ table: 'sueldos', result: { data: [sueldoRow()], error: null } }]);
    const res = await request(app).get('/api/sueldos/mios').set('Authorization', authCli);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('sueldos — archivo (signed URL)', () => {
  it('404 si el recibo no tiene archivo (contador)', async () => {
    sb.queue([{ table: 'sueldos', result: { data: { storage_path: null }, error: null } }]);
    const res = await request(app).get(`/api/sueldos/${SUELDO_ID}/archivo`).set('Authorization', authC);
    expect(res.status).toBe(404);
  });

  it('200 devuelve la signed URL (contador)', async () => {
    sb.queue([{ table: 'sueldos', result: { data: { storage_path: 'estudio-1/sueldos/x.pdf' }, error: null } }]);
    const res = await request(app).get(`/api/sueldos/${SUELDO_ID}/archivo`).set('Authorization', authC);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://signed.example');
    expect(signedUrlComprobante).toHaveBeenCalledWith('estudio-1/sueldos/x.pdf');
  });

  it('200 devuelve la signed URL del recibo PROPIO (cliente)', async () => {
    sb.queue([{ table: 'sueldos', result: { data: { storage_path: 'estudio-1/sueldos/y.pdf' }, error: null } }]);
    const res = await request(app)
      .get(`/api/sueldos/mis-sueldos/${SUELDO_ID}/archivo`)
      .set('Authorization', authCli);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://signed.example');
  });
});

describe('sueldos — actualizar / borrar', () => {
  it('404 al editar un recibo inexistente', async () => {
    sb.queue([{ table: 'sueldos', result: { data: null, error: null } }]);
    const res = await request(app)
      .patch(`/api/sueldos/${SUELDO_ID}`)
      .set('Authorization', authC)
      .send({ monto: '600000' });
    expect(res.status).toBe(404);
  });

  it('200 edita monto (sin tocar Storage)', async () => {
    sb.queue([
      { table: 'sueldos', result: { data: { id: SUELDO_ID, cliente_id: CLIENTE_ID, storage_path: null }, error: null } },
      { table: 'sueldos', result: { data: sueldoRow({ monto: 600000 }), error: null } },
    ]);
    const res = await request(app)
      .patch(`/api/sueldos/${SUELDO_ID}`)
      .set('Authorization', authC)
      .send({ monto: '600000' });
    expect(res.status).toBe(200);
    expect(subirComprobante).not.toHaveBeenCalled();
    const upd = sb.calls.find((c) => c.op === 'update');
    expect(upd?.payload).toMatchObject({ monto: 600000 });
  });

  it('404 al borrar un recibo inexistente', async () => {
    sb.queue([{ table: 'sueldos', result: { data: null, error: null } }]);
    const res = await request(app).delete(`/api/sueldos/${SUELDO_ID}`).set('Authorization', authC);
    expect(res.status).toBe(404);
  });

  it('204 borra la fila y el objeto en Storage', async () => {
    sb.queue([
      { table: 'sueldos', result: { data: { id: SUELDO_ID, storage_path: 'estudio-1/sueldos/z.pdf' }, error: null } },
      { table: 'sueldos', result: { data: null, error: null } },
    ]);
    const res = await request(app).delete(`/api/sueldos/${SUELDO_ID}`).set('Authorization', authC);
    expect(res.status).toBe(204);
    expect(borrarComprobante).toHaveBeenCalledWith('estudio-1/sueldos/z.pdf');
  });
});
