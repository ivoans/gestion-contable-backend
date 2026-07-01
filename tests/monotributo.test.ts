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
const cliente = makeUser({ role: 'cliente', estudio_id: 'estudio-1', condicion_fiscal: 'monotributista' });
const authC = bearerFor(contador);
const authCli = bearerFor(cliente);

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  sb.reset();
  app = createApp();
});

describe('monotributo — PUT /escala (contador)', () => {
  it('400 si escala no es array', async () => {
    const res = await request(app).put('/api/monotributo/escala').set('Authorization', authC).send({ escala: 'x' });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si tope inválido', async () => {
    const res = await request(app)
      .put('/api/monotributo/escala')
      .set('Authorization', authC)
      .send({ escala: [{ categoria: 'A', tope_anual: 0 }] });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si categoría duplicada', async () => {
    const res = await request(app)
      .put('/api/monotributo/escala')
      .set('Authorization', authC)
      .send({ escala: [{ categoria: 'A', tope_anual: 100 }, { categoria: 'a', tope_anual: 200 }] });
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('200 reemplaza la escala y ordena por tope ascendente (orden 0..n)', async () => {
    sb.queue([
      { table: 'monotributo_escala', result: { data: null, error: null } }, // delete
      { table: 'monotributo_escala', result: { data: [{ categoria: 'A' }], error: null } }, // insert
    ]);
    const res = await request(app)
      .put('/api/monotributo/escala')
      .set('Authorization', authC)
      .send({ escala: [
        { categoria: 'C', tope_anual: 300 },
        { categoria: 'A', tope_anual: 100 },
        { categoria: 'B', tope_anual: 200 },
      ] });

    expect(res.status).toBe(200);
    expect(sb.calls[0].op).toBe('delete');
    expect(sb.calls[1].op).toBe('insert');
    expect(sb.calls[1].payload).toEqual([
      { estudio_id: 'estudio-1', categoria: 'A', tope_anual: 100, orden: 0 },
      { estudio_id: 'estudio-1', categoria: 'B', tope_anual: 200, orden: 1 },
      { estudio_id: 'estudio-1', categoria: 'C', tope_anual: 300, orden: 2 },
    ]);
  });

  it('403 si lo intenta un cliente', async () => {
    const res = await request(app).put('/api/monotributo/escala').set('Authorization', authCli).send({ escala: [] });
    expect(res.status).toBe(403);
  });
});

describe('monotributo — GET /mio (cliente): posición vs escala', () => {
  const escala = [
    { categoria: 'A', tope_anual: 1000, orden: 0 },
    { categoria: 'B', tope_anual: 2000, orden: 1 },
    { categoria: 'C', tope_anual: 3000, orden: 2 },
  ];

  function queueMio(facturacion: any[], esc: any[]) {
    sb.queue([
      { table: 'monotributo_facturacion', result: { data: facturacion, error: null } },
      { table: 'monotributo_escala', result: { data: esc, error: null } },
    ]);
  }

  it('cae en la categoría cuyo tope alcanza y expone el próximo tramo', async () => {
    queueMio([{ periodo: '2026-05-01', monto: 1500, comprobantes: 3 }], escala);
    const res = await request(app).get('/api/monotributo/mio').set('Authorization', authCli);
    expect(res.status).toBe(200);
    expect(res.body.acumulado_12m).toBe(1500);
    expect(res.body.categoria).toBe('B');
    expect(res.body.tope).toBe(2000);
    expect(res.body.porcentaje).toBe(0.75);
    expect(res.body.proximo).toEqual({ categoria: 'C', tope: 3000 });
    expect(res.body.excedido).toBe(false);
  });

  it('marca excedido si supera el último tope', async () => {
    queueMio([{ periodo: '2026-05-01', monto: 5000, comprobantes: 9 }], escala);
    const res = await request(app).get('/api/monotributo/mio').set('Authorization', authCli);
    expect(res.body.categoria).toBe('C');
    expect(res.body.excedido).toBe(true);
    expect(res.body.proximo).toBeNull();
  });

  it('escala_configurada=false si el estudio no cargó escala', async () => {
    queueMio([{ periodo: '2026-05-01', monto: 100, comprobantes: 1 }], []);
    const res = await request(app).get('/api/monotributo/mio').set('Authorization', authCli);
    expect(res.body.escala_configurada).toBe(false);
    expect(res.body.categoria).toBeNull();
  });
});

describe('monotributo — GET /resumen (contador ve a un cliente)', () => {
  const escala = [
    { categoria: 'A', tope_anual: 1000, orden: 0 },
    { categoria: 'B', tope_anual: 2000, orden: 1 },
  ];

  it('400 si falta cliente_id válido', async () => {
    const res = await request(app).get('/api/monotributo/resumen').set('Authorization', authC);
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('403 si lo intenta un cliente', async () => {
    const res = await request(app)
      .get('/api/monotributo/resumen')
      .query({ cliente_id: cliente.id })
      .set('Authorization', authCli);
    expect(res.status).toBe(403);
  });

  it('200 devuelve la misma posición que ve el cliente y scopea por estudio', async () => {
    sb.queue([
      { table: 'monotributo_facturacion', result: { data: [{ periodo: '2026-05-01', monto: 1500, comprobantes: 3 }], error: null } },
      { table: 'monotributo_escala', result: { data: escala, error: null } },
    ]);
    const res = await request(app)
      .get('/api/monotributo/resumen')
      .query({ cliente_id: cliente.id })
      .set('Authorization', authC);

    expect(res.status).toBe(200);
    expect(res.body.acumulado_12m).toBe(1500);
    expect(res.body.categoria).toBe('B');
    expect(res.body.excedido).toBe(false);
    // La facturación se filtró por estudio_id (multi-tenant).
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
  });
});
