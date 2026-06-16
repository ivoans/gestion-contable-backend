import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { normalizeCuit } from '../utils/validators';
import { xlsxBufferAFilas } from '../utils/xlsxReader';
import { parsearLibroIVA, RegistroLibroIVA } from '../utils/libroIvaParser';
import {
  Movimiento,
  MovimientoTipo,
  ResumenBloque,
  ResumenLibroIVA,
  ResumenPorAlicuota,
  TendenciaMes,
} from '../types';

const ANIO_MIN = 2024;
const ANIO_MAX = 2100;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 'DD/MM/YYYY' → 'YYYY-MM-DD'. Si ya viene ISO (lo normal en el parser actual),
// se devuelve igual. La columna `fecha` es DATE y necesita YYYY-MM-DD.
function fechaADate(fecha: string): string {
  const m = fecha.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : fecha;
}

// Mapea un registro del parser a la fila jsonb que consume la función SQL.
// Las columnas de contexto (estudio_id, cliente_id, tipo, periodo, origen,
// creado_por) las pone la función desde sus parámetros, no van acá.
function registroAFila(r: RegistroLibroIVA): Record<string, unknown> {
  return {
    fecha: fechaADate(r.fecha),
    tipo_comprobante: r.tipo_comprobante,
    letra: r.letra,
    numero: r.numero,
    contraparte: r.contraparte,
    cuit_contraparte: r.cuit_contraparte,
    neto: r.neto,
    concepto_no_gravado: r.concepto_no_gravado,
    iva: r.iva,
    acrecentamiento: r.acrecentamiento,
    total: r.total,
    retenciones_percepciones: r.retenciones_percepciones,
    op_exentas: r.op_exentas,
  };
}

// POST /api/movimientos/importar — importa un libro IVA (.xlsx) de un cliente.
export async function importarLibroIVA(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, anio: anioRaw, mes: mesRaw } = (req.body ?? {}) as {
    cliente_id?: string;
    anio?: string;
    mes?: string;
  };

  // a. Validar inputs ANTES de tocar la DB.
  if (!cliente_id || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }

  const anio = Number(anioRaw);
  if (!Number.isInteger(anio) || anio < ANIO_MIN || anio > ANIO_MAX) {
    res.status(400).json({ error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}` });
    return;
  }

  const mes = Number(mesRaw);
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    res.status(400).json({ error: 'mes debe ser un entero entre 1 y 12' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'El archivo .xlsx es requerido en el campo "archivo"' });
    return;
  }

  try {
    // b. El cliente debe existir, ser cliente y del estudio del token.
    const { data: cliente, error: clienteError } = await supabase
      .from('users')
      .select('id, cuit')
      .eq('id', cliente_id)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (clienteError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!cliente) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    // c. Leer el .xlsx a filas (helper aislado para poder mockearlo).
    let filas: unknown[][];
    try {
      filas = xlsxBufferAFilas(req.file.buffer);
    } catch {
      res.status(400).json({ error: 'No se pudo leer el archivo .xlsx' });
      return;
    }

    // d. Parsear. El parser tira Error si no es un libro IVA válido.
    let parsed;
    try {
      parsed = parsearLibroIVA(filas);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'El archivo no parece un libro IVA válido',
      });
      return;
    }

    // e. Validaciones que BLOQUEAN la importación.
    const clienteCuit = normalizeCuit((cliente as { cuit: string | null }).cuit);
    if (!clienteCuit) {
      res.status(400).json({ error: 'El cliente no tiene CUIT cargado' });
      return;
    }
    if (parsed.cuit !== clienteCuit) {
      res.status(400).json({ error: 'El CUIT del archivo no coincide con el del cliente' });
      return;
    }
    if (parsed.periodo.anio !== anio || parsed.periodo.mes !== mes) {
      res.status(400).json({ error: 'El período del archivo no coincide con el mes/año seleccionados' });
      return;
    }
    if (parsed.validacion.ok !== true) {
      res.status(400).json({
        error: 'Los totales del archivo no cuadran con lo declarado',
        detalle: parsed.validacion,
      });
      return;
    }

    // f + g. Período como DATE y filas mapeadas.
    const periodo = `${anio}-${String(mes).padStart(2, '0')}-01`;
    const registros = parsed.registros.map(registroAFila);

    // h. Reemplazo atómico (delete + insert) en una sola transacción Postgres.
    const { data, error } = await supabase.rpc('reemplazar_movimientos_importados', {
      p_estudio_id: estudio_id,
      p_cliente_id: cliente_id,
      p_tipo: parsed.tipo,
      p_periodo: periodo,
      p_creado_por: req.user!.id,
      p_registros: registros,
    });

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const { borrados, insertados } = data as { borrados: number; insertados: number };

    // i. Respuesta.
    res.json({
      tipo: parsed.tipo,
      periodo: { anio, mes },
      importados: insertados,
      reemplazados: borrados,
      validacion: { ok: true },
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── CRUD de movimientos MANUALES (origen='manual') ───────────────────────────

// Todas las columnas de la tabla movimientos; shape devuelto en las respuestas.
const MOVIMIENTO_FIELDS =
  'id, estudio_id, cliente_id, tipo, periodo, fecha, tipo_comprobante, letra, numero, ' +
  'contraparte, cuit_contraparte, neto, concepto_no_gravado, iva, acrecentamiento, total, ' +
  'retenciones_percepciones, op_exentas, origen, creado_por, created_at';

const TIPOS_VALIDOS: MovimientoTipo[] = ['compra', 'venta'];

// Strings libres del comprobante.
const STRING_OPCIONALES = [
  'tipo_comprobante', 'letra', 'numero', 'contraparte', 'cuit_contraparte',
] as const;

// Montos opcionales: si vienen, number finito o null. NO se valida positividad
// (notas de crédito / negativos son válidos). concepto_no_gravado y acrecentamiento,
// si NO vienen, quedan en el default 0 del schema (no se incluyen en el payload).
const MONTO_OPCIONALES = [
  'neto', 'concepto_no_gravado', 'iva', 'acrecentamiento', 'retenciones_percepciones', 'op_exentas',
] as const;

function esNumeroFinito(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function esFechaValida(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
}

// Valida anio+mes como par y devuelve el periodo DATE (primer día del mes) o un error.
function validarPeriodo(anioRaw: unknown, mesRaw: unknown): { periodo: string } | { error: string } {
  if (!Number.isInteger(anioRaw) || (anioRaw as number) < ANIO_MIN || (anioRaw as number) > ANIO_MAX) {
    return { error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}` };
  }
  if (!Number.isInteger(mesRaw) || (mesRaw as number) < 1 || (mesRaw as number) > 12) {
    return { error: 'mes debe ser un entero entre 1 y 12' };
  }
  return { periodo: `${anioRaw}-${String(mesRaw).padStart(2, '0')}-01` };
}

// Valida los campos opcionales comunes (strings y montos) y los vuelca en `target`.
// Devuelve un mensaje de error si algo no valida, o null si todo OK.
function recolectarOpcionales(body: Record<string, unknown>, target: Record<string, unknown>): string | null {
  for (const campo of STRING_OPCIONALES) {
    if (body[campo] !== undefined) {
      if (body[campo] !== null && typeof body[campo] !== 'string') {
        return `${campo} debe ser un string`;
      }
      target[campo] = body[campo];
    }
  }
  for (const campo of MONTO_OPCIONALES) {
    if (body[campo] !== undefined) {
      if (body[campo] !== null && !esNumeroFinito(body[campo])) {
        return `${campo} debe ser un número finito o null`;
      }
      target[campo] = body[campo];
    }
  }
  return null;
}

// POST /api/movimientos — crea un movimiento manual (origen='manual').
export async function crearMovimiento(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { cliente_id, tipo, anio, mes, fecha, total } = body;

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }

  if (!TIPOS_VALIDOS.includes(tipo as MovimientoTipo)) {
    res.status(400).json({ error: "tipo debe ser 'compra' o 'venta'" });
    return;
  }

  const periodoResult = validarPeriodo(anio, mes);
  if ('error' in periodoResult) {
    res.status(400).json({ error: periodoResult.error });
    return;
  }

  if (!esFechaValida(fecha)) {
    res.status(400).json({ error: 'fecha debe tener formato YYYY-MM-DD' });
    return;
  }

  if (!esNumeroFinito(total)) {
    res.status(400).json({ error: 'total es requerido y debe ser un número finito' });
    return;
  }

  const row: Record<string, unknown> = {
    estudio_id,
    cliente_id,
    tipo,
    periodo: periodoResult.periodo,
    fecha,
    total,
    origen: 'manual',
    creado_por: req.user!.id,
  };

  const errorOpcional = recolectarOpcionales(body, row);
  if (errorOpcional) {
    res.status(400).json({ error: errorOpcional });
    return;
  }

  try {
    // El cliente debe existir, ser cliente y del estudio del token.
    const { data: cliente, error: clienteError } = await supabase
      .from('users')
      .select('id')
      .eq('id', cliente_id)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (clienteError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!cliente) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    const { data, error } = await supabase
      .from('movimientos')
      .insert(row)
      .select(MOVIMIENTO_FIELDS)
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json(data as unknown as Movimiento);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/movimientos/:id — edita un movimiento MANUAL del estudio.
export async function actualizarMovimiento(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { tipo, anio, mes, fecha, total } = body;

  const updates: Record<string, unknown> = {};

  if (tipo !== undefined) {
    if (!TIPOS_VALIDOS.includes(tipo as MovimientoTipo)) {
      res.status(400).json({ error: "tipo debe ser 'compra' o 'venta'" });
      return;
    }
    updates.tipo = tipo;
  }

  // Período: si viene anio o mes, se exigen ambos para recomponerlo.
  if (anio !== undefined || mes !== undefined) {
    const periodoResult = validarPeriodo(anio, mes);
    if ('error' in periodoResult) {
      res.status(400).json({ error: periodoResult.error });
      return;
    }
    updates.periodo = periodoResult.periodo;
  }

  if (fecha !== undefined) {
    if (!esFechaValida(fecha)) {
      res.status(400).json({ error: 'fecha debe tener formato YYYY-MM-DD' });
      return;
    }
    updates.fecha = fecha;
  }

  if (total !== undefined) {
    if (!esNumeroFinito(total)) {
      res.status(400).json({ error: 'total debe ser un número finito' });
      return;
    }
    updates.total = total;
  }

  const errorOpcional = recolectarOpcionales(body, updates);
  if (errorOpcional) {
    res.status(400).json({ error: errorOpcional });
    return;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    return;
  }

  try {
    const { data: existing, error: findError } = await supabase
      .from('movimientos')
      .select('id, origen')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Movimiento no encontrado' });
      return;
    }

    if ((existing as { origen: string }).origen === 'importado') {
      res.status(400).json({
        error: 'No se puede editar un movimiento importado; los importados se gestionan re-subiendo el libro',
      });
      return;
    }

    const { data, error } = await supabase
      .from('movimientos')
      .update(updates)
      .eq('id', id)
      .select(MOVIMIENTO_FIELDS)
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as unknown as Movimiento);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// DELETE /api/movimientos/:id — borra un movimiento MANUAL del estudio.
export async function eliminarMovimiento(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('movimientos')
      .select('id, origen')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Movimiento no encontrado' });
      return;
    }

    if ((existing as { origen: string }).origen === 'importado') {
      res.status(400).json({
        error: 'No se puede eliminar un movimiento importado; los importados se gestionan re-subiendo el libro',
      });
      return;
    }

    const { error } = await supabase
      .from('movimientos')
      .delete()
      .eq('id', id);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── LECTURA del libro de un cliente por período ──────────────────────────────

// Supabase puede serializar NUMERIC como string; acá se hace aritmética, así que
// se coerciona a number. null/undefined/no-finito → 0 (neutro en las sumas).
function aMonto(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Tasas de IVA estándar AR. La alícuota de un movimiento se infiere como
// iva/neto*100 y se redondea a la más cercana dentro de ±0.5 puntos; si ninguna
// matchea, cae en 'otras'.
const TASAS_ESTANDAR = [21, 10.5, 27, 5, 2.5, 0];
const TOLERANCIA_ALICUOTA = 0.5;

function inferirAlicuota(neto: number, iva: number): number | 'otras' {
  const tasa = (iva / neto) * 100;
  let mejor: number | null = null;
  let mejorDiff = Infinity;
  for (const std of TASAS_ESTANDAR) {
    const diff = Math.abs(tasa - std);
    if (diff < mejorDiff) {
      mejorDiff = diff;
      mejor = std;
    }
  }
  return mejor !== null && mejorDiff <= TOLERANCIA_ALICUOTA ? mejor : 'otras';
}

// Suma un bloque (ventas o compras): cantidad + totales coercionados y redondeados.
function calcularBloque(movs: Movimiento[]): ResumenBloque {
  let total = 0;
  let neto = 0;
  let iva = 0;
  let op_exentas = 0;
  let ret_perc = 0;
  for (const m of movs) {
    total += aMonto(m.total);
    neto += aMonto(m.neto);
    iva += aMonto(m.iva);
    op_exentas += aMonto(m.op_exentas);
    ret_perc += aMonto(m.retenciones_percepciones);
  }
  return {
    cantidad: movs.length,
    total: round2(total),
    neto: round2(neto),
    iva: round2(iva),
    op_exentas: round2(op_exentas),
    ret_perc: round2(ret_perc),
  };
}

// Agrupa por (tipo, alícuota inferida). Solo entran movimientos con neto>0 e iva
// no null; el resto igual cuenta en los totales de bloque, pero no acá.
function calcularPorAlicuota(movs: Movimiento[]): ResumenPorAlicuota[] {
  const grupos = new Map<string, ResumenPorAlicuota>();
  for (const m of movs) {
    if (m.iva === null || m.iva === undefined) continue;
    const neto = aMonto(m.neto);
    if (neto <= 0) continue;
    const iva = aMonto(m.iva);
    const alicuota = inferirAlicuota(neto, iva);
    const key = `${m.tipo}|${alicuota}`;
    const grupo = grupos.get(key);
    if (grupo) {
      grupo.neto = round2(grupo.neto + neto);
      grupo.iva = round2(grupo.iva + iva);
      grupo.cantidad += 1;
    } else {
      grupos.set(key, { tipo: m.tipo, alicuota, neto: round2(neto), iva: round2(iva), cantidad: 1 });
    }
  }
  return [...grupos.values()];
}

function calcularResumen(movs: Movimiento[], anio: number, mes: number): ResumenLibroIVA {
  const ventas = calcularBloque(movs.filter((m) => m.tipo === 'venta'));
  const compras = calcularBloque(movs.filter((m) => m.tipo === 'compra'));
  return {
    periodo: { anio, mes },
    ventas,
    compras,
    iva: { debito: ventas.iva, credito: compras.iva, saldo: round2(ventas.iva - compras.iva) },
    por_alicuota: calcularPorAlicuota(movs),
  };
}

// Valida cliente_id (uuid), anio/mes (par → periodo DATE) y, en el listado, tipo.
// Devuelve { cliente_id, periodo, anio, mes, tipo } o responde el 400 y devuelve null.
function validarQueryLibro(
  req: Request,
  res: Response,
  conTipo: boolean,
): { cliente_id: string; periodo: string; anio: number; mes: number; tipo?: MovimientoTipo } | null {
  const { cliente_id, tipo } = req.query as { cliente_id?: string; tipo?: string };

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return null;
  }

  const anio = Number(req.query.anio);
  const mes = Number(req.query.mes);
  const periodoResult = validarPeriodo(anio, mes);
  if ('error' in periodoResult) {
    res.status(400).json({ error: periodoResult.error });
    return null;
  }

  let tipoValido: MovimientoTipo | undefined;
  if (conTipo && tipo !== undefined) {
    if (!TIPOS_VALIDOS.includes(tipo as MovimientoTipo)) {
      res.status(400).json({ error: "tipo debe ser 'compra' o 'venta'" });
      return null;
    }
    tipoValido = tipo as MovimientoTipo;
  }

  return { cliente_id, periodo: periodoResult.periodo, anio, mes, tipo: tipoValido };
}

// El cliente debe existir, ser cliente y del estudio del token. Devuelve true si OK;
// si no, responde (404/500) y devuelve false.
async function verificarCliente(estudio_id: string | null, cliente_id: string, res: Response): Promise<boolean> {
  const { data: cliente, error } = await supabase
    .from('users')
    .select('id')
    .eq('id', cliente_id)
    .eq('role', 'cliente')
    .eq('estudio_id', estudio_id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Error interno del servidor' });
    return false;
  }
  if (!cliente) {
    res.status(404).json({ error: 'Cliente no encontrado' });
    return false;
  }
  return true;
}

// GET /api/movimientos — listado del libro de un cliente por período.
export async function listarMovimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const q = validarQueryLibro(req, res, true);
  if (!q) return;

  try {
    if (!(await verificarCliente(estudio_id, q.cliente_id, res))) return;

    let query = supabase
      .from('movimientos')
      .select(MOVIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', q.cliente_id)
      .eq('periodo', q.periodo);

    if (q.tipo) query = query.eq('tipo', q.tipo);

    const { data, error } = await query
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json((data ?? []) as unknown as Movimiento[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/movimientos/resumen — resumen recalculado del período (no se persiste).
export async function resumenMovimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const q = validarQueryLibro(req, res, false);
  if (!q) return;

  try {
    if (!(await verificarCliente(estudio_id, q.cliente_id, res))) return;

    const { data, error } = await supabase
      .from('movimientos')
      .select(MOVIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', q.cliente_id)
      .eq('periodo', q.periodo);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const movimientos = ((data ?? []) as unknown) as Movimiento[];
    res.json(calcularResumen(movimientos, q.anio, q.mes));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

const MESES_MIN = 1;
const MESES_MAX = 36;
const MESES_DEFAULT = 12;

// Headline numbers de un período (mes) reusando calcularBloque.
function tendenciaDelMes(anio: number, mes: number, movs: Movimiento[]): TendenciaMes {
  const ventas = calcularBloque(movs.filter((m) => m.tipo === 'venta'));
  const compras = calcularBloque(movs.filter((m) => m.tipo === 'compra'));
  return {
    periodo: { anio, mes },
    cantidad: movs.length,
    ventas_total: ventas.total,
    compras_total: compras.total,
    iva_debito: ventas.iva,
    iva_credito: compras.iva,
    iva_saldo: round2(ventas.iva - compras.iva),
  };
}

type MesVentana = { anio: number; mes: number; periodo: string };

// Ventana cronológica (más viejo → más nuevo) de `meses` meses terminando en
// (anio, mes) inclusive. Cada entrada trae su periodo DATE serializado 'YYYY-MM-01'.
function construirVentanaMeses(anio: number, mes: number, meses: number): MesVentana[] {
  const ventana: MesVentana[] = [];
  const finIdx = anio * 12 + (mes - 1);
  for (let i = meses - 1; i >= 0; i--) {
    const idx = finIdx - i;
    const a = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    ventana.push({ anio: a, mes: m, periodo: `${a}-${String(m).padStart(2, '0')}-01` });
  }
  return ventana;
}

// Agrupa los movimientos por periodo y arma la serie: un TendenciaMes por mes de
// la ventana, en su orden cronológico, con los meses sin datos en 0 (eje continuo).
function armarSerieTendencia(ventana: MesVentana[], movimientos: Movimiento[]): TendenciaMes[] {
  const porPeriodo = new Map<string, Movimiento[]>();
  for (const m of movimientos) {
    const arr = porPeriodo.get(m.periodo);
    if (arr) arr.push(m);
    else porPeriodo.set(m.periodo, [m]);
  }
  return ventana.map(({ anio, mes, periodo }) =>
    tendenciaDelMes(anio, mes, porPeriodo.get(periodo) ?? []),
  );
}

// GET /api/movimientos/tendencia — serie de los últimos `meses` meses terminando
// en (anio, mes) inclusive. Los meses sin datos van en 0 (eje continuo).
export async function tendenciaMovimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const q = validarQueryLibro(req, res, false);
  if (!q) return;

  let meses = MESES_DEFAULT;
  if (req.query.meses !== undefined) {
    meses = Number(req.query.meses);
    if (!Number.isInteger(meses) || meses < MESES_MIN || meses > MESES_MAX) {
      res.status(400).json({ error: `meses debe ser un entero entre ${MESES_MIN} y ${MESES_MAX}` });
      return;
    }
  }

  const ventana = construirVentanaMeses(q.anio, q.mes, meses);

  try {
    if (!(await verificarCliente(estudio_id, q.cliente_id, res))) return;

    // Una sola query: todos los movimientos del estudio+cliente dentro de la ventana.
    const { data, error } = await supabase
      .from('movimientos')
      .select(MOVIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', q.cliente_id)
      .gte('periodo', ventana[0].periodo)
      .lte('periodo', ventana[ventana.length - 1].periodo);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const movimientos = ((data ?? []) as unknown) as Movimiento[];
    res.json(armarSerieTendencia(ventana, movimientos));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── LECTURA del PROPIO libro del CLIENTE logueado (rol cliente, solo lectura) ─
// cliente_id sale del token (req.user.id), NUNCA de la query: si llega un
// cliente_id por query se IGNORA. Multi-tenant por estudio_id del token. Reusa los
// mismos helpers de cálculo que los endpoints de contador (calcularResumen,
// tendenciaDelMes, etc.); solo cambia de dónde sale el cliente_id. El cliente ve
// todos sus movimientos (manual e importado) sin alta/edición/borrado.

// Valida anio/mes (par → periodo DATE) y, en el listado, tipo. NO lee cliente_id.
// Devuelve { periodo, anio, mes, tipo } o responde el 400 y devuelve null.
function validarQueryMisMovimientos(
  req: Request,
  res: Response,
  conTipo: boolean,
): { periodo: string; anio: number; mes: number; tipo?: MovimientoTipo } | null {
  const anio = Number(req.query.anio);
  const mes = Number(req.query.mes);
  const periodoResult = validarPeriodo(anio, mes);
  if ('error' in periodoResult) {
    res.status(400).json({ error: periodoResult.error });
    return null;
  }

  let tipoValido: MovimientoTipo | undefined;
  const { tipo } = req.query as { tipo?: string };
  if (conTipo && tipo !== undefined) {
    if (!TIPOS_VALIDOS.includes(tipo as MovimientoTipo)) {
      res.status(400).json({ error: "tipo debe ser 'compra' o 'venta'" });
      return null;
    }
    tipoValido = tipo as MovimientoTipo;
  }

  return { periodo: periodoResult.periodo, anio, mes, tipo: tipoValido };
}

// GET /api/movimientos/mis-movimientos — el cliente lee su propio libro por período.
export async function listarMisMovimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.user!.id;
  const q = validarQueryMisMovimientos(req, res, true);
  if (!q) return;

  try {
    let query = supabase
      .from('movimientos')
      .select(MOVIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .eq('periodo', q.periodo);

    if (q.tipo) query = query.eq('tipo', q.tipo);

    const { data, error } = await query
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json((data ?? []) as unknown as Movimiento[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/movimientos/mis-movimientos/resumen — resumen recalculado del cliente.
export async function resumenMisMovimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.user!.id;
  const q = validarQueryMisMovimientos(req, res, false);
  if (!q) return;

  try {
    const { data, error } = await supabase
      .from('movimientos')
      .select(MOVIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .eq('periodo', q.periodo);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const movimientos = ((data ?? []) as unknown) as Movimiento[];
    res.json(calcularResumen(movimientos, q.anio, q.mes));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/movimientos/mis-movimientos/tendencia — serie de los últimos `meses`
// meses (default 12) del cliente, misma ventana/cálculo que tendenciaMovimientos.
export async function tendenciaMisMovimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.user!.id;
  const q = validarQueryMisMovimientos(req, res, false);
  if (!q) return;

  let meses = MESES_DEFAULT;
  if (req.query.meses !== undefined) {
    meses = Number(req.query.meses);
    if (!Number.isInteger(meses) || meses < MESES_MIN || meses > MESES_MAX) {
      res.status(400).json({ error: `meses debe ser un entero entre ${MESES_MIN} y ${MESES_MAX}` });
      return;
    }
  }

  const ventana = construirVentanaMeses(q.anio, q.mes, meses);

  try {
    const { data, error } = await supabase
      .from('movimientos')
      .select(MOVIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .gte('periodo', ventana[0].periodo)
      .lte('periodo', ventana[ventana.length - 1].periodo);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const movimientos = ((data ?? []) as unknown) as Movimiento[];
    res.json(armarSerieTendencia(ventana, movimientos));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
