// tests/movimientos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb, xlsxMock, parserMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return {
    sb: createSupabaseMock() as SupabaseMock,
    xlsxMock: { xlsxBufferAFilas: vi.fn() },
    parserMock: { parsearLibroIVA: vi.fn() },
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/utils/xlsxReader', () => ({ xlsxBufferAFilas: xlsxMock.xlsxBufferAFilas }));
vi.mock('../src/utils/libroIvaParser', () => ({ parsearLibroIVA: parserMock.parsearLibroIVA }));

import { createApp } from '../src/app';

// uuids reales (el endpoint valida formato uuid en cliente_id).
const CLIENTE_A = '11111111-1111-4111-8111-111111111111';
const CLIENTE_OTRO = '22222222-2222-4222-8222-222222222222';
const MOV_ID = '33333333-3333-4333-8333-333333333333';

// Fila de movimiento con shape MOVIMIENTO_FIELDS (todas las columnas de la tabla).
const makeMov = (over: Record<string, unknown> = {}) => ({
  id: MOV_ID,
  estudio_id: 'estudio-A',
  cliente_id: CLIENTE_A,
  tipo: 'compra',
  periodo: '2026-04-01',
  fecha: '2026-04-05',
  tipo_comprobante: null,
  letra: null,
  numero: null,
  contraparte: null,
  cuit_contraparte: null,
  neto: null,
  concepto_no_gravado: 0,
  iva: null,
  acrecentamiento: 0,
  total: 121,
  retenciones_percepciones: null,
  op_exentas: null,
  origen: 'manual',
  creado_por: 'contadorA',
  created_at: '2026-04-05T12:00:00.000Z',
  ...over,
});

describe('movimientos — POST /api/movimientos/importar', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const contadorB = makeUser({ id: 'contadorB', role: 'contador', estudio_id: 'estudio-B' });
  const admin = makeUser({ role: 'admin' });
  const clienteUser = makeUser({ id: CLIENTE_A, role: 'cliente', estudio_id: 'estudio-A' });

  const authA = bearerFor(contadorA);
  const authB = bearerFor(contadorB);
  const adminAuth = bearerFor(admin);
  const clienteAuth = bearerFor(clienteUser);

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // Salida estándar del parser para el happy path. CUIT normalizado = '23167092144'.
  const okParse = (over: Record<string, unknown> = {}) => ({
    tipo: 'compra',
    periodo: { anio: 2026, mes: 4 },
    cuit: '23167092144',
    registros: [
      {
        fecha: '2026-03-14',
        tipo_comprobante: 'TIQUE F',
        letra: 'A',
        numero: '0020-00043417',
        contraparte: 'MATEAZZI CLAU',
        cuit_contraparte: '27-23240873-7',
        neto: 57053.69,
        concepto_no_gravado: 978.1,
        iva: 11981.27,
        acrecentamiento: 0,
        total: 70013.06,
        retenciones_percepciones: null,
        op_exentas: null,
      },
      {
        // fecha en DD/MM/YYYY para verificar la conversión a DATE en el endpoint.
        fecha: '05/04/2026',
        tipo_comprobante: 'FACTURA',
        letra: 'A',
        numero: '0001-1',
        contraparte: 'SEGUROS',
        cuit_contraparte: '30-50005031-0',
        neto: 100,
        concepto_no_gravado: 0,
        iva: 21,
        acrecentamiento: 0,
        total: 121,
        retenciones_percepciones: 10,
        op_exentas: null,
      },
    ],
    totalesArchivo: {},
    sumas: {},
    validacion: { ok: true, diferencias: [] },
    ...over,
  });

  // Request multipart helper con file adjunto.
  const importar = (auth: string | null) => {
    let r = request(app).post('/api/movimientos/importar');
    if (auth) r = r.set('Authorization', auth);
    return r;
  };

  const conArchivo = (r: request.Test) =>
    r.attach('archivo', Buffer.from('fake-xlsx'), { filename: 'libro.xlsx', contentType: XLSX_MIME });

  beforeEach(() => {
    sb.reset();
    xlsxMock.xlsxBufferAFilas.mockReset().mockReturnValue([['fila']]);
    parserMock.parsearLibroIVA.mockReset().mockReturnValue(okParse());
    app = createApp();
  });

  // ── Auth / roles ───────────────────────────────────────────────────────────
  it('401 sin token', async () => {
    const res = await importar(null).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4');
    expect(res.status).toBe(401);
    expect(sb.calls).toHaveLength(0);
  });

  it('403 si role=cliente', async () => {
    const res = await importar(clienteAuth).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4');
    expect(res.status).toBe(403);
    expect(sb.calls).toHaveLength(0);
  });

  it('403 si role=admin', async () => {
    const res = await importar(adminAuth).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4');
    expect(res.status).toBe(403);
    expect(sb.calls).toHaveLength(0);
  });

  // ── Validación de inputs (antes de tocar la DB) ──────────────────────────────
  it('400 si falta cliente_id', async () => {
    const res = await conArchivo(importar(authA).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si cliente_id no es uuid', async () => {
    const res = await conArchivo(importar(authA).field('cliente_id', 'no-uuid').field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si anio fuera de rango', async () => {
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '1999').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si mes inválido', async () => {
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '13'));
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('400 si falta el archivo', async () => {
    const res = await importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/archivo/i);
    expect(sb.calls).toHaveLength(0);
  });

  // ── Cliente (cross-estudio / inexistente / no-cliente) → 404 ─────────────────
  it('404 si el cliente es de otro estudio', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: null } }]);
    const res = await conArchivo(importar(authB).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(404);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    expect(sb.rpcCalls).toHaveLength(0);
  });

  it('404 si el cliente no existe / no es cliente', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: null } }]);
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_OTRO).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(404);
    expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
    expect(sb.rpcCalls).toHaveLength(0);
  });

  // ── Parser / validaciones de negocio → 400 ───────────────────────────────────
  it('400 si el archivo no es un libro IVA válido (parser tira Error)', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: '23-16709214-4' }, error: null } }]);
    parserMock.parsearLibroIVA.mockImplementation(() => {
      throw new Error('El archivo no parece un libro IVA válido');
    });
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El archivo no parece un libro IVA válido');
    expect(sb.rpcCalls).toHaveLength(0);
  });

  it('400 si el cliente no tiene CUIT cargado', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: null }, error: null } }]);
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El cliente no tiene CUIT cargado');
    expect(sb.rpcCalls).toHaveLength(0);
  });

  it('400 si el CUIT del archivo no coincide con el del cliente', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: '20-11111111-2' }, error: null } }]);
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El CUIT del archivo no coincide con el del cliente');
    expect(sb.rpcCalls).toHaveLength(0);
  });

  it('400 si el período del archivo no coincide', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: '23-16709214-4' }, error: null } }]);
    parserMock.parsearLibroIVA.mockReturnValue(okParse({ periodo: { anio: 2026, mes: 3 } }));
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/período del archivo no coincide/i);
    expect(sb.rpcCalls).toHaveLength(0);
  });

  it('400 si los totales no cuadran (incluye detalle)', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: '23-16709214-4' }, error: null } }]);
    const validacion = {
      ok: false,
      diferencias: [{ campo: 'neto', archivo: 100, calculado: 200, diff: -100 }],
    };
    parserMock.parsearLibroIVA.mockReturnValue(okParse({ validacion }));
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Los totales del archivo no cuadran con lo declarado');
    expect(res.body.detalle).toEqual(validacion);
    expect(sb.rpcCalls).toHaveLength(0);
  });

  // ── 500 si la rpc falla ──────────────────────────────────────────────────────
  it('500 si la rpc devuelve error', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: '23-16709214-4' }, error: null } }]);
    sb.queueRpc([{ fn: 'reemplazar_movimientos_importados', result: { data: null, error: { message: 'boom' } } }]);
    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Error interno del servidor');
  });

  // ── Happy path ───────────────────────────────────────────────────────────────
  it('200 importa: llama la rpc con los args correctos y responde resumen', async () => {
    sb.queue([{ table: 'users', result: { data: { id: CLIENTE_A, cuit: '23-16709214-4' }, error: null } }]);
    sb.queueRpc([
      { fn: 'reemplazar_movimientos_importados', result: { data: { borrados: 2, insertados: 5 }, error: null } },
    ]);

    const res = await conArchivo(importar(authA).field('cliente_id', CLIENTE_A).field('anio', '2026').field('mes', '4'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tipo: 'compra',
      periodo: { anio: 2026, mes: 4 },
      importados: 5,
      reemplazados: 2,
      validacion: { ok: true },
    });

    // rpc con el contexto del token + período como DATE.
    expect(sb.rpcCalls).toHaveLength(1);
    const rpc = sb.rpcCalls[0];
    expect(rpc.fn).toBe('reemplazar_movimientos_importados');
    expect(rpc.args).toMatchObject({
      p_estudio_id: 'estudio-A',
      p_cliente_id: CLIENTE_A,
      p_tipo: 'compra',
      p_periodo: '2026-04-01',
      p_creado_por: contadorA.id,
    });

    // registros mapeados: sin columnas de contexto, fecha siempre YYYY-MM-DD.
    expect(rpc.args.p_registros).toHaveLength(2);
    expect(rpc.args.p_registros[0]).toMatchObject({
      fecha: '2026-03-14',
      tipo_comprobante: 'TIQUE F',
      neto: 57053.69,
      retenciones_percepciones: null,
    });
    expect(rpc.args.p_registros[0]).not.toHaveProperty('estudio_id');
    // DD/MM/YYYY → YYYY-MM-DD.
    expect(rpc.args.p_registros[1].fecha).toBe('2026-04-05');
    expect(rpc.args.p_registros[1].retenciones_percepciones).toBe(10);
  });
});

describe('movimientos — CRUD manual', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const contadorB = makeUser({ id: 'contadorB', role: 'contador', estudio_id: 'estudio-B' });
  const admin = makeUser({ role: 'admin' });
  const clienteUser = makeUser({ id: CLIENTE_A, role: 'cliente', estudio_id: 'estudio-A' });

  const authA = bearerFor(contadorA);
  const authB = bearerFor(contadorB);
  const adminAuth = bearerFor(admin);
  const clienteAuth = bearerFor(clienteUser);

  // Body válido mínimo para crear un movimiento manual.
  const validBody = (over: Record<string, unknown> = {}) => ({
    cliente_id: CLIENTE_A,
    tipo: 'compra',
    anio: 2026,
    mes: 4,
    fecha: '2026-04-05',
    total: 121,
    ...over,
  });

  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  // ── POST /api/movimientos ────────────────────────────────────────────────────
  describe('POST /api/movimientos', () => {
    const post = (auth: string | null, body: unknown) => {
      let r = request(app).post('/api/movimientos');
      if (auth) r = r.set('Authorization', auth);
      return r.send(body as object);
    };

    it('401 sin token', async () => {
      const res = await post(null, validBody());
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await post(clienteAuth, validBody());
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await post(adminAuth, validBody());
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si falta cliente_id', async () => {
      const res = await post(authA, validBody({ cliente_id: undefined }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si cliente_id no es uuid', async () => {
      const res = await post(authA, validBody({ cliente_id: 'no-uuid' }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si tipo es inválido', async () => {
      const res = await post(authA, validBody({ tipo: 'otro' }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await post(authA, validBody({ anio: 1999 }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await post(authA, validBody({ mes: 13 }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si fecha mal formada', async () => {
      const res = await post(authA, validBody({ fecha: '05/04/2026' }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si falta total', async () => {
      const res = await post(authA, validBody({ total: undefined }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si total no es finito', async () => {
      const res = await post(authA, validBody({ total: 'x' }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si un monto opcional no es finito', async () => {
      const res = await post(authA, validBody({ neto: 'x' }));
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si el cliente es de otro estudio', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await post(authB, validBody());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cliente no encontrado');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('404 si el cliente no existe / no es cliente', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await post(authA, validBody({ cliente_id: CLIENTE_OTRO }));
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
    });

    it('201 acepta total NEGATIVO (notas de crédito)', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: CLIENTE_A }, error: null } },
        { table: 'movimientos', result: { data: makeMov({ total: -500 }), error: null } },
      ]);
      const res = await post(authA, validBody({ total: -500 }));
      expect(res.status).toBe(201);
      expect(res.body.total).toBe(-500);
      expect(sb.calls[1].payload.total).toBe(-500);
    });

    it('201 crea: fuerza origen/estudio/creado_por y devuelve shape MOVIMIENTO_FIELDS', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: CLIENTE_A }, error: null } },
        { table: 'movimientos', result: { data: makeMov(), error: null } },
      ]);
      const res = await post(authA, validBody());

      expect(res.status).toBe(201);
      expect(res.body).toEqual(makeMov());

      // El insert fija el contexto del token + período recompuesto; los defaults
      // (concepto_no_gravado / acrecentamiento) NO se mandan → quedan en 0 por schema.
      const payload = sb.calls[1].payload;
      expect(payload).toMatchObject({
        estudio_id: 'estudio-A',
        cliente_id: CLIENTE_A,
        tipo: 'compra',
        periodo: '2026-04-01',
        fecha: '2026-04-05',
        total: 121,
        origen: 'manual',
        creado_por: 'contadorA',
      });
      expect(payload).not.toHaveProperty('concepto_no_gravado');
      expect(payload).not.toHaveProperty('acrecentamiento');
    });
  });

  // ── PATCH /api/movimientos/:id ───────────────────────────────────────────────
  describe('PATCH /api/movimientos/:id', () => {
    const patch = (auth: string | null, id: string, body: unknown) => {
      let r = request(app).patch(`/api/movimientos/${id}`);
      if (auth) r = r.set('Authorization', auth);
      return r.send(body as object);
    };

    it('401 sin token', async () => {
      const res = await patch(null, MOV_ID, { total: 1 });
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await patch(clienteAuth, MOV_ID, { total: 1 });
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await patch(adminAuth, MOV_ID, { total: 1 });
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si no se envió ningún campo', async () => {
      const res = await patch(authA, MOV_ID, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No se enviaron campos para actualizar');
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si tipo es inválido', async () => {
      const res = await patch(authA, MOV_ID, { tipo: 'otro' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si viene anio sin mes', async () => {
      const res = await patch(authA, MOV_ID, { anio: 2026 });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si fecha mal formada', async () => {
      const res = await patch(authA, MOV_ID, { fecha: 'x' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si total no es finito', async () => {
      const res = await patch(authA, MOV_ID, { total: 'x' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si un monto opcional no es finito', async () => {
      const res = await patch(authA, MOV_ID, { neto: 'x' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si no existe / otro estudio', async () => {
      sb.queue([{ table: 'movimientos', result: { data: null, error: null } }]);
      const res = await patch(authB, MOV_ID, { total: 200 });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Movimiento no encontrado');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('400 si el movimiento es importado', async () => {
      sb.queue([{ table: 'movimientos', result: { data: { id: MOV_ID, origen: 'importado' }, error: null } }]);
      const res = await patch(authA, MOV_ID, { total: 200 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        'No se puede editar un movimiento importado; los importados se gestionan re-subiendo el libro',
      );
      expect(sb.calls).toHaveLength(1);
    });

    it('200 acepta total NEGATIVO', async () => {
      sb.queue([
        { table: 'movimientos', result: { data: { id: MOV_ID, origen: 'manual' }, error: null } },
        { table: 'movimientos', result: { data: makeMov({ total: -500 }), error: null } },
      ]);
      const res = await patch(authA, MOV_ID, { total: -500 });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(-500);
      expect(sb.calls[1].payload.total).toBe(-500);
    });

    it('200 actualiza y devuelve shape MOVIMIENTO_FIELDS', async () => {
      sb.queue([
        { table: 'movimientos', result: { data: { id: MOV_ID, origen: 'manual' }, error: null } },
        { table: 'movimientos', result: { data: makeMov({ tipo: 'venta' }), error: null } },
      ]);
      const res = await patch(authA, MOV_ID, { tipo: 'venta', anio: 2026, mes: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(makeMov({ tipo: 'venta' }));
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ tipo: 'venta', periodo: '2026-05-01' });
    });
  });

  // ── DELETE /api/movimientos/:id ──────────────────────────────────────────────
  describe('DELETE /api/movimientos/:id', () => {
    const del = (auth: string | null, id: string) => {
      let r = request(app).delete(`/api/movimientos/${id}`);
      if (auth) r = r.set('Authorization', auth);
      return r;
    };

    it('401 sin token', async () => {
      const res = await del(null, MOV_ID);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await del(clienteAuth, MOV_ID);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await del(adminAuth, MOV_ID);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si no existe / otro estudio', async () => {
      sb.queue([{ table: 'movimientos', result: { data: null, error: null } }]);
      const res = await del(authB, MOV_ID);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Movimiento no encontrado');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('400 si el movimiento es importado', async () => {
      sb.queue([{ table: 'movimientos', result: { data: { id: MOV_ID, origen: 'importado' }, error: null } }]);
      const res = await del(authA, MOV_ID);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        'No se puede eliminar un movimiento importado; los importados se gestionan re-subiendo el libro',
      );
      expect(sb.calls).toHaveLength(1);
    });

    it('204 borra un movimiento manual', async () => {
      sb.queue([
        { table: 'movimientos', result: { data: { id: MOV_ID, origen: 'manual' }, error: null } },
        { table: 'movimientos', result: { data: null, error: null } },
      ]);
      const res = await del(authA, MOV_ID);
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(sb.calls[1].op).toBe('delete');
      expect(sb.calls[1].filters).toContainEqual(['eq', 'id', MOV_ID]);
    });
  });
});

describe('movimientos — LECTURA', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const contadorB = makeUser({ id: 'contadorB', role: 'contador', estudio_id: 'estudio-B' });
  const admin = makeUser({ role: 'admin' });
  const clienteUser = makeUser({ id: CLIENTE_A, role: 'cliente', estudio_id: 'estudio-A' });

  const authA = bearerFor(contadorA);
  const authB = bearerFor(contadorB);
  const adminAuth = bearerFor(admin);
  const clienteAuth = bearerFor(clienteUser);

  // Query válida mínima.
  const baseQuery = { cliente_id: CLIENTE_A, anio: '2026', mes: '4' };

  const clienteOk = { table: 'users', result: { data: { id: CLIENTE_A }, error: null } } as const;
  const clienteNull = { table: 'users', result: { data: null, error: null } } as const;

  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  // ── GET /api/movimientos (listado) ───────────────────────────────────────────
  describe('GET /api/movimientos', () => {
    const list = (auth: string | null, query: Record<string, string>) => {
      let r = request(app).get('/api/movimientos');
      if (auth) r = r.set('Authorization', auth);
      return r.query(query);
    };

    it('401 sin token', async () => {
      const res = await list(null, baseQuery);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await list(clienteAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await list(adminAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si cliente_id no es uuid', async () => {
      const res = await list(authA, { ...baseQuery, cliente_id: 'no-uuid' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await list(authA, { ...baseQuery, anio: '1999' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await list(authA, { ...baseQuery, mes: '13' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si tipo es inválido', async () => {
      const res = await list(authA, { ...baseQuery, tipo: 'otro' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si el cliente es de otro estudio', async () => {
      sb.queue([clienteNull]);
      const res = await list(authB, baseQuery);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cliente no encontrado');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls).toHaveLength(1);
    });

    it('404 si el cliente no existe / no es cliente', async () => {
      sb.queue([clienteNull]);
      const res = await list(authA, { ...baseQuery, cliente_id: CLIENTE_OTRO });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
    });

    it('200 devuelve array ordenado con shape MOVIMIENTO_FIELDS', async () => {
      const filas = [
        makeMov({ fecha: '2026-04-02', tipo: 'venta' }),
        makeMov({ fecha: '2026-04-10', tipo: 'compra' }),
      ];
      sb.queue([clienteOk, { table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await list(authA, baseQuery);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(filas);

      // Filtra por estudio+cliente+periodo y ordena fecha asc, created_at asc.
      const q = sb.calls[1];
      expect(q.table).toBe('movimientos');
      expect(q.filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(q.filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(q.filters).toContainEqual(['eq', 'periodo', '2026-04-01']);
      expect(q.filters).toContainEqual(['order', 'fecha', { ascending: true }]);
      expect(q.filters).toContainEqual(['order', 'created_at', { ascending: true }]);
      // sin tipo → no se filtra por tipo.
      expect(q.filters.some((f) => f[0] === 'eq' && f[1] === 'tipo')).toBe(false);
    });

    it('200 filtra por tipo cuando viene', async () => {
      sb.queue([clienteOk, { table: 'movimientos', result: { data: [], error: null } }]);
      const res = await list(authA, { ...baseQuery, tipo: 'venta' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'tipo', 'venta']);
    });

    it('500 si la query de movimientos falla', async () => {
      sb.queue([clienteOk, { table: 'movimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await list(authA, baseQuery);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error interno del servidor');
    });
  });

  // ── GET /api/movimientos/resumen ─────────────────────────────────────────────
  describe('GET /api/movimientos/resumen', () => {
    const resumen = (auth: string | null, query: Record<string, string>) => {
      let r = request(app).get('/api/movimientos/resumen');
      if (auth) r = r.set('Authorization', auth);
      return r.query(query);
    };

    it('401 sin token', async () => {
      const res = await resumen(null, baseQuery);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await resumen(clienteAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await resumen(adminAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await resumen(authA, { ...baseQuery, anio: '2101' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await resumen(authA, { ...baseQuery, mes: '0' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si el cliente es de otro estudio', async () => {
      sb.queue([clienteNull]);
      const res = await resumen(authB, baseQuery);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cliente no encontrado');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls).toHaveLength(1);
    });

    it('404 si el cliente no existe / no es cliente', async () => {
      sb.queue([clienteNull]);
      const res = await resumen(authA, { ...baseQuery, cliente_id: CLIENTE_OTRO });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
    });

    it('200 recalcula la matemática (montos como string → coerciona)', async () => {
      // Supabase puede mandar NUMERIC como string; el back coerciona a number.
      const filas = [
        makeMov({ tipo: 'venta', neto: '100.00', iva: '21.00', total: '121.00' }),
        makeMov({ tipo: 'compra', neto: '50.00', iva: '5.25', total: '55.25' }),
      ];
      sb.queue([clienteOk, { table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await resumen(authA, baseQuery);

      expect(res.status).toBe(200);
      expect(res.body.periodo).toEqual({ anio: 2026, mes: 4 });
      expect(res.body.ventas).toEqual({
        cantidad: 1, total: 121, neto: 100, iva: 21, op_exentas: 0, ret_perc: 0,
      });
      expect(res.body.compras).toEqual({
        cantidad: 1, total: 55.25, neto: 50, iva: 5.25, op_exentas: 0, ret_perc: 0,
      });
      expect(res.body.iva).toEqual({ debito: 21, credito: 5.25, saldo: 15.75 });

      // por_alicuota: bucket 21% para la venta, 10.5% para la compra.
      expect(res.body.por_alicuota).toContainEqual({
        tipo: 'venta', alicuota: 21, neto: 100, iva: 21, cantidad: 1,
      });
      expect(res.body.por_alicuota).toContainEqual({
        tipo: 'compra', alicuota: 10.5, neto: 50, iva: 5.25, cantidad: 1,
      });
      expect(res.body.por_alicuota).toHaveLength(2);

      // No se filtró por tipo (trae todo el período).
      expect(sb.calls[1].filters).toContainEqual(['eq', 'periodo', '2026-04-01']);
      expect(sb.calls[1].filters.some((f) => f[0] === 'eq' && f[1] === 'tipo')).toBe(false);
    });

    it('200 iva=null (monotributista): suma 0 y no entra en por_alicuota', async () => {
      const filas = [
        makeMov({ tipo: 'venta', neto: null, iva: null, total: '100.00' }),
        makeMov({ tipo: 'venta', neto: '100.00', iva: '21.00', total: '121.00' }),
      ];
      sb.queue([clienteOk, { table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await resumen(authA, baseQuery);

      expect(res.status).toBe(200);
      // El mov sin iva igual cuenta en cantidad/total, su iva suma 0.
      expect(res.body.ventas).toEqual({
        cantidad: 2, total: 221, neto: 100, iva: 21, op_exentas: 0, ret_perc: 0,
      });
      expect(res.body.iva).toEqual({ debito: 21, credito: 0, saldo: 21 });
      // Solo la venta con iva entra en por_alicuota.
      expect(res.body.por_alicuota).toEqual([
        { tipo: 'venta', alicuota: 21, neto: 100, iva: 21, cantidad: 1 },
      ]);
    });

    it('200 sin movimientos: bloques en cero y por_alicuota vacío', async () => {
      sb.queue([clienteOk, { table: 'movimientos', result: { data: [], error: null } }]);
      const res = await resumen(authA, baseQuery);
      expect(res.status).toBe(200);
      expect(res.body.ventas).toEqual({ cantidad: 0, total: 0, neto: 0, iva: 0, op_exentas: 0, ret_perc: 0 });
      expect(res.body.compras).toEqual({ cantidad: 0, total: 0, neto: 0, iva: 0, op_exentas: 0, ret_perc: 0 });
      expect(res.body.iva).toEqual({ debito: 0, credito: 0, saldo: 0 });
      expect(res.body.por_alicuota).toEqual([]);
    });

    it('500 si la query de movimientos falla', async () => {
      sb.queue([clienteOk, { table: 'movimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await resumen(authA, baseQuery);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error interno del servidor');
    });
  });

  // ── GET /api/movimientos/tendencia ───────────────────────────────────────────
  describe('GET /api/movimientos/tendencia', () => {
    const tendencia = (auth: string | null, query: Record<string, string>) => {
      let r = request(app).get('/api/movimientos/tendencia');
      if (auth) r = r.set('Authorization', auth);
      return r.query(query);
    };

    const mesDe = (serie: any[], anio: number, mes: number) =>
      serie.find((x) => x.periodo.anio === anio && x.periodo.mes === mes);

    it('401 sin token', async () => {
      const res = await tendencia(null, baseQuery);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await tendencia(clienteAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await tendencia(adminAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await tendencia(authA, { ...baseQuery, anio: '1999' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await tendencia(authA, { ...baseQuery, mes: '13' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si meses fuera de 1–36', async () => {
      const res = await tendencia(authA, { ...baseQuery, meses: '37' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si meses no es entero', async () => {
      const res = await tendencia(authA, { ...baseQuery, meses: '0' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si el cliente es de otro estudio', async () => {
      sb.queue([clienteNull]);
      const res = await tendencia(authB, baseQuery);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cliente no encontrado');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls).toHaveLength(1);
    });

    it('404 si el cliente no existe / no es cliente', async () => {
      sb.queue([clienteNull]);
      const res = await tendencia(authA, { ...baseQuery, cliente_id: CLIENTE_OTRO });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
    });

    it('200 serie default 12 meses: ventana, orden, totales y meses vacíos en 0', async () => {
      // Ventana anio=2026 mes=4 meses=12 → 2025-05 .. 2026-04 (12 meses).
      // Datos en 3 períodos; montos como string para ejercitar la coerción.
      const filas = [
        makeMov({ tipo: 'venta', periodo: '2026-04-01', neto: '100.00', iva: '21.00', total: '121.00' }),
        makeMov({ tipo: 'compra', periodo: '2026-04-01', neto: '50.00', iva: '5.25', total: '55.25' }),
        makeMov({ tipo: 'venta', periodo: '2026-03-01', neto: '200.00', iva: '42.00', total: '242.00' }),
        makeMov({ tipo: 'compra', periodo: '2025-12-01', neto: '500.00', iva: '10.50', total: '510.50' }),
      ];
      sb.queue([clienteOk, { table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await tendencia(authA, baseQuery);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(12);
      // Orden cronológico ascendente: primero 2025-05, último 2026-04.
      expect(res.body[0].periodo).toEqual({ anio: 2025, mes: 5 });
      expect(res.body[11].periodo).toEqual({ anio: 2026, mes: 4 });

      // Una sola query, con la ventana como rango sobre periodo.
      expect(sb.calls[1].filters).toContainEqual(['gte', 'periodo', '2025-05-01']);
      expect(sb.calls[1].filters).toContainEqual(['lte', 'periodo', '2026-04-01']);

      expect(mesDe(res.body, 2026, 4)).toEqual({
        periodo: { anio: 2026, mes: 4 },
        cantidad: 2, ventas_total: 121, compras_total: 55.25,
        iva_debito: 21, iva_credito: 5.25, iva_saldo: 15.75,
      });
      expect(mesDe(res.body, 2026, 3)).toEqual({
        periodo: { anio: 2026, mes: 3 },
        cantidad: 1, ventas_total: 242, compras_total: 0,
        iva_debito: 42, iva_credito: 0, iva_saldo: 42,
      });
      expect(mesDe(res.body, 2025, 12)).toEqual({
        periodo: { anio: 2025, mes: 12 },
        cantidad: 1, ventas_total: 0, compras_total: 510.5,
        iva_debito: 0, iva_credito: 10.5, iva_saldo: -10.5,
      });
      // Mes sin movimientos → todo en 0.
      expect(mesDe(res.body, 2025, 5)).toEqual({
        periodo: { anio: 2025, mes: 5 },
        cantidad: 0, ventas_total: 0, compras_total: 0,
        iva_debito: 0, iva_credito: 0, iva_saldo: 0,
      });
    });

    it('200 respeta meses custom y cruza el año hacia atrás', async () => {
      // meses=3 terminando en 2026-04 → 2026-02, 2026-03, 2026-04.
      sb.queue([clienteOk, { table: 'movimientos', result: { data: [], error: null } }]);
      const res = await tendencia(authA, { ...baseQuery, meses: '3' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(res.body.map((x: any) => x.periodo)).toEqual([
        { anio: 2026, mes: 2 },
        { anio: 2026, mes: 3 },
        { anio: 2026, mes: 4 },
      ]);
      expect(sb.calls[1].filters).toContainEqual(['gte', 'periodo', '2026-02-01']);
      expect(sb.calls[1].filters).toContainEqual(['lte', 'periodo', '2026-04-01']);
    });

    it('500 si la query de movimientos falla', async () => {
      sb.queue([clienteOk, { table: 'movimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await tendencia(authA, baseQuery);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error interno del servidor');
    });
  });
});

describe('movimientos — LECTURA CLIENTE (mis-movimientos)', () => {
  let app: ReturnType<typeof createApp>;

  // El cliente logueado es CLIENTE_A del estudio-A; el back resuelve cliente_id
  // desde el token, no de la query.
  const clienteA = makeUser({ id: CLIENTE_A, role: 'cliente', estudio_id: 'estudio-A' });
  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const admin = makeUser({ role: 'admin' });

  const authCliente = bearerFor(clienteA);
  const authContador = bearerFor(contadorA);
  const adminAuth = bearerFor(admin);

  // Query válida mínima: el cliente NO manda cliente_id.
  const baseQuery = { anio: '2026', mes: '4' };

  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  // ── GET /api/movimientos/mis-movimientos (listado) ───────────────────────────
  describe('GET /api/movimientos/mis-movimientos', () => {
    const list = (auth: string | null, query: Record<string, string>) => {
      let r = request(app).get('/api/movimientos/mis-movimientos');
      if (auth) r = r.set('Authorization', auth);
      return r.query(query);
    };

    it('401 sin token', async () => {
      const res = await list(null, baseQuery);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=contador', async () => {
      const res = await list(authContador, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await list(adminAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await list(authCliente, { ...baseQuery, anio: '1999' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await list(authCliente, { ...baseQuery, mes: '13' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si tipo es inválido', async () => {
      const res = await list(authCliente, { ...baseQuery, tipo: 'otro' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('200 filtra por req.user.id + estudio del token, ordenado, shape MOVIMIENTO_FIELDS', async () => {
      const filas = [
        makeMov({ fecha: '2026-04-02', tipo: 'venta' }),
        makeMov({ fecha: '2026-04-10', tipo: 'compra' }),
      ];
      sb.queue([{ table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await list(authCliente, baseQuery);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(filas);

      // Una sola query: no hay verificarCliente (el cliente es el del token).
      expect(sb.calls).toHaveLength(1);
      const q = sb.calls[0];
      expect(q.table).toBe('movimientos');
      expect(q.filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(q.filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(q.filters).toContainEqual(['eq', 'periodo', '2026-04-01']);
      expect(q.filters).toContainEqual(['order', 'fecha', { ascending: true }]);
      expect(q.filters).toContainEqual(['order', 'created_at', { ascending: true }]);
      expect(q.filters.some((f) => f[0] === 'eq' && f[1] === 'tipo')).toBe(false);
    });

    it('200 ignora cliente_id de la query: usa SIEMPRE el del token', async () => {
      sb.queue([{ table: 'movimientos', result: { data: [], error: null } }]);
      const res = await list(authCliente, { ...baseQuery, cliente_id: CLIENTE_OTRO });
      expect(res.status).toBe(200);
      // El filtro de cliente_id es el del token, NUNCA el de la query.
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'cliente_id', CLIENTE_OTRO]);
    });

    it('200 filtra por tipo cuando viene', async () => {
      sb.queue([{ table: 'movimientos', result: { data: [], error: null } }]);
      const res = await list(authCliente, { ...baseQuery, tipo: 'venta' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'tipo', 'venta']);
    });

    it('500 si la query de movimientos falla', async () => {
      sb.queue([{ table: 'movimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await list(authCliente, baseQuery);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error interno del servidor');
    });
  });

  // ── GET /api/movimientos/mis-movimientos/resumen ─────────────────────────────
  describe('GET /api/movimientos/mis-movimientos/resumen', () => {
    const resumen = (auth: string | null, query: Record<string, string>) => {
      let r = request(app).get('/api/movimientos/mis-movimientos/resumen');
      if (auth) r = r.set('Authorization', auth);
      return r.query(query);
    };

    it('401 sin token', async () => {
      const res = await resumen(null, baseQuery);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=contador', async () => {
      const res = await resumen(authContador, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await resumen(adminAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await resumen(authCliente, { ...baseQuery, anio: '2101' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await resumen(authCliente, { ...baseQuery, mes: '0' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('200 recalcula el resumen (shape ResumenLibroIVA) filtrando por el token', async () => {
      const filas = [
        makeMov({ tipo: 'venta', neto: '100.00', iva: '21.00', total: '121.00' }),
        makeMov({ tipo: 'compra', neto: '50.00', iva: '5.25', total: '55.25' }),
      ];
      sb.queue([{ table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await resumen(authCliente, baseQuery);

      expect(res.status).toBe(200);
      expect(res.body.periodo).toEqual({ anio: 2026, mes: 4 });
      expect(res.body.ventas).toEqual({
        cantidad: 1, total: 121, neto: 100, iva: 21, op_exentas: 0, ret_perc: 0,
      });
      expect(res.body.compras).toEqual({
        cantidad: 1, total: 55.25, neto: 50, iva: 5.25, op_exentas: 0, ret_perc: 0,
      });
      expect(res.body.iva).toEqual({ debito: 21, credito: 5.25, saldo: 15.75 });
      expect(res.body.por_alicuota).toContainEqual({
        tipo: 'venta', alicuota: 21, neto: 100, iva: 21, cantidad: 1,
      });
      expect(res.body.por_alicuota).toContainEqual({
        tipo: 'compra', alicuota: 10.5, neto: 50, iva: 5.25, cantidad: 1,
      });

      // Una sola query, filtrada por el cliente del token.
      expect(sb.calls).toHaveLength(1);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'periodo', '2026-04-01']);
    });

    it('200 ignora cliente_id de la query: usa SIEMPRE el del token', async () => {
      sb.queue([{ table: 'movimientos', result: { data: [], error: null } }]);
      const res = await resumen(authCliente, { ...baseQuery, cliente_id: CLIENTE_OTRO });
      expect(res.status).toBe(200);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'cliente_id', CLIENTE_OTRO]);
    });

    it('500 si la query de movimientos falla', async () => {
      sb.queue([{ table: 'movimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await resumen(authCliente, baseQuery);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error interno del servidor');
    });
  });

  // ── GET /api/movimientos/mis-movimientos/tendencia ───────────────────────────
  describe('GET /api/movimientos/mis-movimientos/tendencia', () => {
    const tendencia = (auth: string | null, query: Record<string, string>) => {
      let r = request(app).get('/api/movimientos/mis-movimientos/tendencia');
      if (auth) r = r.set('Authorization', auth);
      return r.query(query);
    };

    const mesDe = (serie: any[], anio: number, mes: number) =>
      serie.find((x) => x.periodo.anio === anio && x.periodo.mes === mes);

    it('401 sin token', async () => {
      const res = await tendencia(null, baseQuery);
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=contador', async () => {
      const res = await tendencia(authContador, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await tendencia(adminAuth, baseQuery);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await tendencia(authCliente, { ...baseQuery, anio: '1999' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await tendencia(authCliente, { ...baseQuery, mes: '13' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si meses fuera de 1–36', async () => {
      const res = await tendencia(authCliente, { ...baseQuery, meses: '37' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si meses no es entero', async () => {
      const res = await tendencia(authCliente, { ...baseQuery, meses: '0' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('200 serie default 12 meses filtrando por el token (shape TendenciaMes[])', async () => {
      const filas = [
        makeMov({ tipo: 'venta', periodo: '2026-04-01', neto: '100.00', iva: '21.00', total: '121.00' }),
        makeMov({ tipo: 'compra', periodo: '2026-04-01', neto: '50.00', iva: '5.25', total: '55.25' }),
        makeMov({ tipo: 'venta', periodo: '2026-03-01', neto: '200.00', iva: '42.00', total: '242.00' }),
        makeMov({ tipo: 'compra', periodo: '2025-12-01', neto: '500.00', iva: '10.50', total: '510.50' }),
      ];
      sb.queue([{ table: 'movimientos', result: { data: filas, error: null } }]);

      const res = await tendencia(authCliente, baseQuery);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(12);
      expect(res.body[0].periodo).toEqual({ anio: 2025, mes: 5 });
      expect(res.body[11].periodo).toEqual({ anio: 2026, mes: 4 });

      // Una sola query, filtrada por el cliente del token + ventana sobre periodo.
      expect(sb.calls).toHaveLength(1);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(sb.calls[0].filters).toContainEqual(['gte', 'periodo', '2025-05-01']);
      expect(sb.calls[0].filters).toContainEqual(['lte', 'periodo', '2026-04-01']);

      expect(mesDe(res.body, 2026, 4)).toEqual({
        periodo: { anio: 2026, mes: 4 },
        cantidad: 2, ventas_total: 121, compras_total: 55.25,
        iva_debito: 21, iva_credito: 5.25, iva_saldo: 15.75,
      });
      expect(mesDe(res.body, 2025, 12)).toEqual({
        periodo: { anio: 2025, mes: 12 },
        cantidad: 1, ventas_total: 0, compras_total: 510.5,
        iva_debito: 0, iva_credito: 10.5, iva_saldo: -10.5,
      });
      expect(mesDe(res.body, 2025, 5)).toEqual({
        periodo: { anio: 2025, mes: 5 },
        cantidad: 0, ventas_total: 0, compras_total: 0,
        iva_debito: 0, iva_credito: 0, iva_saldo: 0,
      });
    });

    it('200 respeta meses custom', async () => {
      sb.queue([{ table: 'movimientos', result: { data: [], error: null } }]);
      const res = await tendencia(authCliente, { ...baseQuery, meses: '3' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(res.body.map((x: any) => x.periodo)).toEqual([
        { anio: 2026, mes: 2 },
        { anio: 2026, mes: 3 },
        { anio: 2026, mes: 4 },
      ]);
      expect(sb.calls[0].filters).toContainEqual(['gte', 'periodo', '2026-02-01']);
      expect(sb.calls[0].filters).toContainEqual(['lte', 'periodo', '2026-04-01']);
    });

    it('200 ignora cliente_id de la query: usa SIEMPRE el del token', async () => {
      sb.queue([{ table: 'movimientos', result: { data: [], error: null } }]);
      const res = await tendencia(authCliente, { ...baseQuery, cliente_id: CLIENTE_OTRO });
      expect(res.status).toBe(200);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', CLIENTE_A]);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'cliente_id', CLIENTE_OTRO]);
    });

    it('500 si la query de movimientos falla', async () => {
      sb.queue([{ table: 'movimientos', result: { data: null, error: { message: 'boom' } } }]);
      const res = await tendencia(authCliente, baseQuery);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Error interno del servidor');
    });
  });
});
