import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { normalizeCuit } from '../utils/validators';
import { xlsxBufferAFilas } from '../utils/xlsxReader';
import { parsearLibroIVA, RegistroLibroIVA } from '../utils/libroIvaParser';
import { Movimiento, MovimientoTipo } from '../types';

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
