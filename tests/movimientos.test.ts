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
