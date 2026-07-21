import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { Honorario, HonorarioPlan, EstadoHonorario } from '../types';
import {
  generarHonorarios,
  generarHonorarioClientePeriodoActual,
  fechaVencimientoDe,
  descripcionPeriodo,
} from '../services/honorariosService';
import { isValidUuid } from '../utils/validators';
import { periodoAnteriorAR, formatFechaCorta } from '../utils/fechas';
import { entregarNotificacion } from '../services/notificacionesService';
import { sendNuevoHonorario } from '../services/emailService';
import { sendPushToUser } from '../services/pushService';
import { borrarComprobante } from '../lib/storage';

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO_RE = /^\d{4}-\d{2}$/;
const ESTADOS_VALIDOS: EstadoHonorario[] = ['pendiente', 'vencido', 'pagado', 'anulado'];

// Tope de meses por carga retroactiva (3 años de deuda histórica alcanza y sobra).
const MAX_MESES_RETROACTIVOS = 36;

function esMontoValido(m: unknown): m is number {
  return typeof m === 'number' && Number.isFinite(m) && m > 0;
}

function hoyISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Aviso inmediato al cliente (email + push, tipo 'nuevo') al crear un honorario a mano.
// Best-effort: un fallo acá no voltea el alta (el cron diario lo reintenta igual).
async function despacharAvisoNuevoHonorario(
  honorario: Honorario,
  cliente: { nombre: string; email: string },
): Promise<void> {
  try {
    await entregarNotificacion({
      target: { honorario_id: honorario.id },
      user_id: honorario.cliente_id,
      tipo: 'nuevo',
      enviar: () =>
        sendNuevoHonorario(cliente.email, {
          nombre: cliente.nombre,
          descripcion: honorario.descripcion ?? 'Honorarios',
          monto: honorario.monto,
          fecha_vencimiento: honorario.fecha_vencimiento,
        }),
    });
    await entregarNotificacion({
      target: { honorario_id: honorario.id },
      user_id: honorario.cliente_id,
      tipo: 'nuevo',
      canal: 'push',
      enviar: () =>
        sendPushToUser(honorario.cliente_id, {
          title: 'Nuevos honorarios',
          body: `${honorario.descripcion ?? 'Honorarios'} — vence el ${formatFechaCorta(honorario.fecha_vencimiento)}.`,
          url: '/cliente/honorarios',
        }),
    });
  } catch (err) {
    console.error(`[honorarios] Falló el aviso del honorario ${honorario.id} (reintenta el cron):`, err);
  }
}

// El cliente debe existir, ser 'cliente' y del estudio del contador. Devuelve
// nombre/email (para el aviso) o null si no corresponde.
async function buscarClienteDelEstudio(
  clienteId: string,
  estudio_id: string | null,
): Promise<{ id: string; nombre: string; email: string } | null | { error: true }> {
  const { data, error } = await supabase
    .from('users')
    .select('id, nombre, email')
    .eq('id', clienteId)
    .eq('role', 'cliente')
    .eq('estudio_id', estudio_id)
    .maybeSingle();
  if (error) return { error: true };
  return (data as { id: string; nombre: string; email: string } | null) ?? null;
}

// ── CONTADOR ────────────────────────────────────────────────────────────────

// GET /api/honorarios — lista los honorarios del estudio. Filtros: cliente_id, estado, periodo (YYYY-MM).
export async function listarHonorarios(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, estado, periodo } = req.query as {
    cliente_id?: string;
    estado?: string;
    periodo?: string;
  };

  if (cliente_id && !isValidUuid(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  if (estado && !ESTADOS_VALIDOS.includes(estado as EstadoHonorario)) {
    res.status(400).json({ error: 'estado inválido' });
    return;
  }
  if (periodo && !PERIODO_RE.test(periodo)) {
    res.status(400).json({ error: 'periodo debe tener formato YYYY-MM' });
    return;
  }

  try {
    let query = supabase
      .from('honorarios')
      .select('*')
      .eq('estudio_id', estudio_id)
      .order('periodo', { ascending: false })
      .order('fecha_vencimiento', { ascending: true });

    if (cliente_id) query = query.eq('cliente_id', cliente_id);
    if (estado) query = query.eq('estado', estado as EstadoHonorario);
    if (periodo) query = query.eq('periodo', `${periodo}-01`);

    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Honorario[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/honorarios/resumen — totales por estado del estudio (para el dashboard).
export async function resumenHonorarios(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('honorarios')
      .select('estado, monto')
      .eq('estudio_id', estudio_id);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const filas = (data ?? []) as { estado: EstadoHonorario; monto: number }[];
    const init = () => ({ count: 0, monto: 0 });
    const resumen = {
      pendiente: init(),
      vencido: init(),
      pagado: init(),
    };

    for (const f of filas) {
      if (f.estado === 'anulado') continue;
      const bucket = resumen[f.estado];
      bucket.count += 1;
      bucket.monto += Number(f.monto);
    }

    res.json(resumen);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// POST /api/honorarios/generar — genera los honorarios de un período a partir de los
// planes activos del estudio. A MES VENCIDO: el default es el período ANTERIOR (en
// julio se genera "junio", que vence en julio). Idempotente.
export async function generarHonorariosEndpoint(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id!;
  const { anio: anioRaw, mes: mesRaw } = (req.body ?? {}) as { anio?: unknown; mes?: unknown };
  const periodoDefault = periodoAnteriorAR();

  let anio: number;
  if (anioRaw === undefined) {
    anio = periodoDefault.anio;
  } else if (Number.isInteger(anioRaw) && (anioRaw as number) >= 2024 && (anioRaw as number) <= 2100) {
    anio = anioRaw as number;
  } else {
    res.status(400).json({ error: 'anio debe ser un entero entre 2024 y 2100' });
    return;
  }

  let mes: number;
  if (mesRaw === undefined) {
    mes = periodoDefault.mes;
  } else if (Number.isInteger(mesRaw) && (mesRaw as number) >= 1 && (mesRaw as number) <= 12) {
    mes = mesRaw as number;
  } else {
    res.status(400).json({ error: 'mes debe ser un entero entre 1 y 12' });
    return;
  }

  try {
    const result = await generarHonorarios({ estudio_id, anio, mes, creado_por: req.user!.id });
    if ('error' in result) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// POST /api/honorarios — crea un honorario SUELTO (sin plan, periodo NULL): trabajos
// puntuales tipo "manifestación de bienes". descripcion obligatoria (es lo que ve el
// cliente). Si el vencimiento ya pasó entra directo como 'vencido'.
export async function crearHonorario(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, monto, fecha_vencimiento, descripcion } = req.body as {
    cliente_id?: string;
    monto?: number;
    fecha_vencimiento?: string;
    descripcion?: string;
  };

  if (!cliente_id || !isValidUuid(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  if (!esMontoValido(monto)) {
    res.status(400).json({ error: 'monto debe ser un número positivo' });
    return;
  }
  if (!fecha_vencimiento || !FECHA_RE.test(fecha_vencimiento) || isNaN(Date.parse(fecha_vencimiento))) {
    res.status(400).json({ error: 'fecha_vencimiento debe tener formato YYYY-MM-DD' });
    return;
  }
  if (typeof descripcion !== 'string' || descripcion.trim().length === 0) {
    res.status(400).json({ error: 'descripcion es requerida' });
    return;
  }

  try {
    const cliente = await buscarClienteDelEstudio(cliente_id, estudio_id);
    if (cliente && 'error' in cliente) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!cliente) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    const { data, error } = await supabase
      .from('honorarios')
      .insert({
        estudio_id,
        cliente_id,
        creado_por: req.user!.id,
        periodo: null,
        monto,
        fecha_vencimiento,
        descripcion: descripcion.trim(),
        estado: fecha_vencimiento < hoyISO() ? 'vencido' : 'pendiente',
      })
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const honorario = data as Honorario;
    await despacharAvisoNuevoHonorario(honorario, cliente);
    res.status(201).json(honorario);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// POST /api/honorarios/retroactivos — carga en lote la deuda histórica de un cliente:
// un honorario por mes del rango [desde, hasta] (YYYY-MM), con el monto dado. Los que
// ya vencieron entran directo como 'vencido'. Idempotente contra el UNIQUE
// (cliente_id, periodo): los meses que ya existían se saltean.
export async function crearHonorariosRetroactivos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, desde, hasta, monto, dia_vencimiento } = req.body as {
    cliente_id?: string;
    desde?: string;
    hasta?: string;
    monto?: number;
    dia_vencimiento?: number;
  };

  if (!cliente_id || !isValidUuid(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  if (!desde || !PERIODO_RE.test(desde) || !hasta || !PERIODO_RE.test(hasta)) {
    res.status(400).json({ error: 'desde y hasta deben tener formato YYYY-MM' });
    return;
  }
  if (desde > hasta) {
    res.status(400).json({ error: 'desde no puede ser posterior a hasta' });
    return;
  }
  if (!esMontoValido(monto)) {
    res.status(400).json({ error: 'monto debe ser un número positivo' });
    return;
  }
  let dia = 10;
  if (dia_vencimiento !== undefined) {
    if (!Number.isInteger(dia_vencimiento) || dia_vencimiento < 1 || dia_vencimiento > 28) {
      res.status(400).json({ error: 'dia_vencimiento debe ser un entero entre 1 y 28' });
      return;
    }
    dia = dia_vencimiento;
  }

  const [anioDesde, mesDesde] = desde.split('-').map(Number);
  const [anioHasta, mesHasta] = hasta.split('-').map(Number);
  const totalMeses = (anioHasta - anioDesde) * 12 + (mesHasta - mesDesde) + 1;
  if (totalMeses > MAX_MESES_RETROACTIVOS) {
    res.status(400).json({ error: `El rango no puede superar ${MAX_MESES_RETROACTIVOS} meses` });
    return;
  }

  try {
    const cliente = await buscarClienteDelEstudio(cliente_id, estudio_id);
    if (cliente && 'error' in cliente) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!cliente) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    const hoy = hoyISO();
    const rows = [];
    for (let i = 0; i < totalMeses; i++) {
      const mesAbs = mesDesde - 1 + i;
      const anio = anioDesde + Math.floor(mesAbs / 12);
      const mes = (mesAbs % 12) + 1;
      const fecha_vencimiento = fechaVencimientoDe(anio, mes, dia);
      rows.push({
        estudio_id,
        cliente_id,
        creado_por: req.user!.id,
        periodo: `${anio}-${String(mes).padStart(2, '0')}-01`,
        monto,
        fecha_vencimiento,
        descripcion: descripcionPeriodo(anio, mes),
        estado: (fecha_vencimiento < hoy ? 'vencido' : 'pendiente') as EstadoHonorario,
      });
    }

    const { data: inserted, error } = await supabase
      .from('honorarios')
      .upsert(rows, { onConflict: 'cliente_id, periodo', ignoreDuplicates: true })
      .select('id');

    if (error || !inserted) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json({ creados: inserted.length, ya_existentes: rows.length - inserted.length });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/honorarios/:id — edita monto/fecha_vencimiento/descripcion (no si pagado/anulado).
export async function actualizarHonorario(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { monto, fecha_vencimiento, descripcion } = req.body as {
    monto?: number;
    fecha_vencimiento?: string;
    descripcion?: string | null;
  };

  if (monto !== undefined && !esMontoValido(monto)) {
    res.status(400).json({ error: 'monto debe ser un número positivo' });
    return;
  }
  if (
    fecha_vencimiento !== undefined &&
    (!FECHA_RE.test(fecha_vencimiento) || isNaN(Date.parse(fecha_vencimiento)))
  ) {
    res.status(400).json({ error: 'fecha_vencimiento debe tener formato YYYY-MM-DD' });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (monto !== undefined) updates.monto = monto;
  if (fecha_vencimiento !== undefined) updates.fecha_vencimiento = fecha_vencimiento;
  if (descripcion !== undefined) updates.descripcion = descripcion;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    return;
  }

  try {
    const { data: existing, error: findError } = await supabase
      .from('honorarios')
      .select('id, estado')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const actual = existing as { id: string; estado: EstadoHonorario } | null;
    if (!actual) {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }
    if (actual.estado === 'pagado') {
      res.status(400).json({ error: 'No se puede editar un honorario pagado' });
      return;
    }
    if (actual.estado === 'anulado') {
      res.status(400).json({ error: 'No se puede editar un honorario anulado' });
      return;
    }

    const { data, error } = await supabase
      .from('honorarios')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Honorario);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/honorarios/:id/estado — la contadora marca pagado.
export async function cambiarEstadoHonorario(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('honorarios')
      .select('id, estado')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const actual = existing as { id: string; estado: EstadoHonorario } | null;
    if (!actual) {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }
    if (actual.estado === 'pagado') {
      res.status(400).json({ error: 'El honorario ya está pagado' });
      return;
    }
    if (actual.estado === 'anulado') {
      res.status(400).json({ error: 'El honorario está anulado' });
      return;
    }

    const { data, error } = await supabase
      .from('honorarios')
      .update({ estado: 'pagado', pagado_at: new Date().toISOString(), pagado_por: req.user!.id })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Honorario);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/honorarios/:id/revertir — vuelve un pagado a pendiente/vencido según la fecha.
export async function revertirHonorario(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('honorarios')
      .select('id, estado, fecha_vencimiento')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const actual = existing as
      | { id: string; estado: EstadoHonorario; fecha_vencimiento: string }
      | null;
    if (!actual) {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }
    if (actual.estado !== 'pagado') {
      res.status(400).json({ error: 'Solo se puede revertir un honorario pagado' });
      return;
    }

    // Si el cobro tenía recibo emitido, se anula (fila + PDF en Storage) ANTES de
    // revertir: un recibo de un honorario no pagado no tiene sentido, y si la
    // reversión luego falla la contadora puede re-emitirlo.
    const { data: recibo } = await supabase
      .from('recibos')
      .select('id, storage_path')
      .eq('honorario_id', id)
      .maybeSingle();
    const reciboRow = recibo as { id: string; storage_path: string } | null;
    if (reciboRow) {
      await supabase.from('recibos').delete().eq('id', reciboRow.id);
      await borrarComprobante(reciboRow.storage_path);
    }

    const nuevoEstado: EstadoHonorario = actual.fecha_vencimiento < hoyISO() ? 'vencido' : 'pendiente';

    const { data, error } = await supabase
      .from('honorarios')
      .update({ estado: nuevoEstado, pagado_at: null, pagado_por: null })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Honorario);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/honorarios/:id/anular — la contadora anula un honorario (no si está pagado).
export async function anularHonorario(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('honorarios')
      .select('id, estado')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const actual = existing as { id: string; estado: EstadoHonorario } | null;
    if (!actual) {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }
    if (actual.estado === 'pagado') {
      res.status(400).json({ error: 'No se puede anular un honorario pagado; revertilo primero' });
      return;
    }

    const { data, error } = await supabase
      .from('honorarios')
      .update({ estado: 'anulado' })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Honorario);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── PLANES (abono recurrente) ────────────────────────────────────────────────

// GET /api/honorarios/planes — planes del estudio + nombre del cliente.
export async function listarPlanes(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('honorarios_plan')
      .select('*, cliente:users!cliente_id(nombre, email)')
      .eq('estudio_id', estudio_id)
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data ?? []);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PUT /api/honorarios/planes/:clienteId — crea o actualiza el plan del cliente.
export async function upsertPlan(req: Request, res: Response): Promise<void> {
  const { clienteId } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { monto, dia_vencimiento, activo } = req.body as {
    monto?: number;
    dia_vencimiento?: number;
    activo?: boolean;
  };

  if (!esMontoValido(monto)) {
    res.status(400).json({ error: 'monto debe ser un número positivo' });
    return;
  }
  let dia = 10;
  if (dia_vencimiento !== undefined) {
    if (!Number.isInteger(dia_vencimiento) || dia_vencimiento < 1 || dia_vencimiento > 28) {
      res.status(400).json({ error: 'dia_vencimiento debe ser un entero entre 1 y 28' });
      return;
    }
    dia = dia_vencimiento;
  }

  try {
    // El cliente debe existir, ser 'cliente' y del estudio del contador.
    const { data: cliente, error: clienteError } = await supabase
      .from('users')
      .select('id')
      .eq('id', clienteId)
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
      .from('honorarios_plan')
      .upsert(
        {
          estudio_id,
          cliente_id: clienteId,
          monto,
          dia_vencimiento: dia,
          activo: activo === undefined ? true : activo === true,
        },
        { onConflict: 'cliente_id' },
      )
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const plan = data as HonorarioPlan;

    // Generar el honorario del mes actual en el acto, así aparece para contadora y
    // cliente sin tener que tocar "Generar mes actual". Idempotente; si falla, el plan
    // igual quedó guardado.
    if (plan.activo) {
      try {
        await generarHonorarioClientePeriodoActual({
          estudio_id: plan.estudio_id,
          cliente_id: plan.cliente_id,
          monto: plan.monto,
          dia_vencimiento: plan.dia_vencimiento,
          creado_por: req.user!.id,
        });
      } catch {
        // best-effort
      }
    }

    res.json(plan);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── CLIENTE ──────────────────────────────────────────────────────────────────

// GET /api/honorarios/mis-honorarios — el cliente ve lo que debe (sin anulados), agrupado.
export async function misHonorarios(req: Request, res: Response): Promise<void> {
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('honorarios')
      .select('*')
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .neq('estado', 'anulado')
      .order('fecha_vencimiento', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const honorarios = (data ?? []) as Honorario[];
    res.json({
      pendientes: honorarios.filter((h) => h.estado === 'pendiente'),
      vencidos: honorarios.filter((h) => h.estado === 'vencido'),
      pagados: honorarios.filter((h) => h.estado === 'pagado'),
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/honorarios/mis-honorarios/:id/estado — el cliente marca pagado un honorario propio.
export async function pagarMiHonorario(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('honorarios')
      .select('id, estado')
      .eq('id', id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const actual = existing as { id: string; estado: EstadoHonorario } | null;
    // El cliente no ve anulados: tratarlos como inexistentes.
    if (!actual || actual.estado === 'anulado') {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }
    if (actual.estado === 'pagado') {
      res.status(400).json({ error: 'El honorario ya está pagado' });
      return;
    }

    const { data, error } = await supabase
      .from('honorarios')
      .update({ estado: 'pagado', pagado_at: new Date().toISOString(), pagado_por: cliente_id })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Honorario);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
