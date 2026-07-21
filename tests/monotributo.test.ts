import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb, xlsxMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return {
    sb: createSupabaseMock() as SupabaseMock,
    xlsxMock: { xlsxBufferAFilas: vi.fn() },
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));
// Se mockea solo la lectura del .xlsx (no el parser): el parser real corre sobre
// las filas que devuelve el mock, así el test cubre la cadena parser + controller.
vi.mock('../src/utils/xlsxReader', () => ({ xlsxBufferAFilas: xlsxMock.xlsxBufferAFilas }));

import { createApp } from '../src/app';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Encabezado (recortado) del export AFIP "Mis Comprobantes Emitidos".
const HEADER = [
  'Fecha', 'Tipo', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización',
  'Tipo Doc. Receptor', 'Nro. Doc. Receptor', 'Denominación Receptor', 'Tipo Cambio', 'Moneda',
  'Neto Grav. IVA 0%', 'IVA 2,5%', 'Neto Grav. IVA 2,5%', 'IVA 5%', 'Neto Grav. IVA 5%',
  'IVA 10,5%', 'Neto Grav. IVA 10,5%', 'IVA 21%', 'Neto Grav. IVA 21%', 'IVA 27%',
  'Neto Grav. IVA 27%', 'Neto Gravado Total', 'Neto No Gravado', 'Op. Exentas', 'Otros Tributos',
  'Total IVA', 'Imp. Total',
];
// Fila de detalle con las columnas que persiste el detalle.
function filaComp(fecha: string, tipo: string, pv: string, nro: string, impTotal: string): string[] {
  const r = new Array(28).fill('');
  r[0] = fecha; r[1] = tipo; r[2] = pv; r[3] = nro; r[4] = nro; r[27] = impTotal;
  return r;
}

const contador = makeUser({ role: 'contador', estudio_id: 'estudio-1' });
const cliente = makeUser({ role: 'cliente', estudio_id: 'estudio-1', condicion_fiscal: 'monotributista' });
const authC = bearerFor(contador);
const authCli = bearerFor(cliente);

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  sb.reset();
  xlsxMock.xlsxBufferAFilas.mockReset().mockReturnValue([]);
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

describe('monotributo — POST /facturacion/import (detalle + agregado)', () => {
  const importar = () =>
    request(app)
      .post('/api/monotributo/facturacion/import')
      .set('Authorization', authC)
      .field('cliente_id', cliente.id)
      .attach('archivo', Buffer.from('fake-xlsx'), { filename: 'comp.xlsx', contentType: XLSX_MIME });

  it('upsertea el agregado y reemplaza el detalle por período (delete + insert)', async () => {
    xlsxMock.xlsxBufferAFilas.mockReturnValue([
      ['Mis Comprobantes Emitidos - CUIT 20231414143'],
      HEADER,
      filaComp('01/05/2026', '11 - Factura C', '6', '7561', '17500'),
      filaComp('05/05/2026', '13 - Nota de Crédito C', '6', '7562', '2500'),
    ]);
    sb.queue([
      { table: 'users', result: { data: { id: cliente.id, cuit: null, condicion_fiscal: 'monotributista' }, error: null } },
      { table: 'monotributo_facturacion', result: { data: null, error: null } }, // upsert agregado
      { table: 'monotributo_comprobantes', result: { data: null, error: null } }, // delete por período
      { table: 'monotributo_comprobantes', result: { data: null, error: null } }, // insert detalle
    ]);

    const res = await importar();
    expect(res.status).toBe(200);
    expect(res.body.importados).toBe(1); // un período (mayo)
    expect(res.body.comprobantes).toBe(2); // dos comprobantes

    // Orden de operaciones: users → upsert facturacion → delete comprobantes → insert.
    expect(sb.calls[1].op).toBe('upsert');
    expect(sb.calls[1].table).toBe('monotributo_facturacion');
    expect(sb.calls[2].op).toBe('delete');
    expect(sb.calls[2].table).toBe('monotributo_comprobantes');
    expect(sb.calls[2].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
    expect(sb.calls[3].op).toBe('insert');

    // El agregado del mes = 17500 − 2500 (la NC resta).
    const factura = sb.calls[1].payload as { periodo: string; monto: number }[];
    expect(factura[0]).toMatchObject({ periodo: '2026-05-01', monto: 15000 });

    // El detalle guarda la NC con imp_total negativo y el período correcto.
    const detalle = sb.calls[3].payload as { periodo: string; imp_total: number; tipo: string; punto_venta: string }[];
    expect(detalle).toHaveLength(2);
    expect(detalle[0]).toMatchObject({ periodo: '2026-05-01', imp_total: 17500, punto_venta: '6' });
    expect(detalle[1].imp_total).toBe(-2500);
  });

  it('500 si falla el insert del detalle', async () => {
    xlsxMock.xlsxBufferAFilas.mockReturnValue([
      ['Mis Comprobantes Emitidos'],
      HEADER,
      filaComp('01/05/2026', '11 - Factura C', '6', '7561', '17500'),
    ]);
    sb.queue([
      { table: 'users', result: { data: { id: cliente.id, cuit: null, condicion_fiscal: 'monotributista' }, error: null } },
      { table: 'monotributo_facturacion', result: { data: null, error: null } },
      { table: 'monotributo_comprobantes', result: { data: null, error: null } },
      { table: 'monotributo_comprobantes', result: { data: null, error: { message: 'boom' } } },
    ]);
    const res = await importar();
    expect(res.status).toBe(500);
  });
});

describe('monotributo — GET /mio/comprobantes (cliente)', () => {
  it('400 si falta mes/anio', async () => {
    const res = await request(app).get('/api/monotributo/mio/comprobantes').set('Authorization', authCli);
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('200 devuelve el detalle del período, scopeado por cliente logueado + estudio', async () => {
    sb.queue([
      { table: 'monotributo_comprobantes', result: { data: [{ id: 'c1', periodo: '2026-05-01', imp_total: 17500 }], error: null } },
    ]);
    const res = await request(app)
      .get('/api/monotributo/mio/comprobantes')
      .query({ anio: 2026, mes: 5 })
      .set('Authorization', authCli);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'periodo', '2026-05-01']);
  });
});

describe('monotributo — GET /comprobantes (contador)', () => {
  it('400 si falta cliente_id válido', async () => {
    const res = await request(app)
      .get('/api/monotributo/comprobantes')
      .query({ anio: 2026, mes: 5 })
      .set('Authorization', authC);
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si mes inválido', async () => {
    const res = await request(app)
      .get('/api/monotributo/comprobantes')
      .query({ cliente_id: cliente.id, anio: 2026, mes: 13 })
      .set('Authorization', authC);
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('403 si lo intenta un cliente', async () => {
    const res = await request(app)
      .get('/api/monotributo/comprobantes')
      .query({ cliente_id: cliente.id, anio: 2026, mes: 5 })
      .set('Authorization', authCli);
    expect(res.status).toBe(403);
  });

  it('200 devuelve el detalle del cliente elegido y scopea por estudio', async () => {
    sb.queue([
      { table: 'monotributo_comprobantes', result: { data: [{ id: 'c1', periodo: '2026-05-01', imp_total: 17500 }], error: null } },
    ]);
    const res = await request(app)
      .get('/api/monotributo/comprobantes')
      .query({ cliente_id: cliente.id, anio: 2026, mes: 5 })
      .set('Authorization', authC);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-1']);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', cliente.id]);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'periodo', '2026-05-01']);
  });
});
