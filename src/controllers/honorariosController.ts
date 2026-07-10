import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { Honorario, HonorarioPlan, EstadoHonorario } from '../types';
import { generarHonorarios, generarHonorarioClienteMesActual } from '../services/honorariosService';
import { isValidUuid } from '../utils/validators';

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO_RE = /^\d{4}-\d{2}$/;
const ESTADOS_VALIDOS: EstadoHonorario[] = ['pendiente', 'vencido', 'pagado', 'anulado'];

function esMontoValido(m: unknown): m is number {
  return typeof m === 'number' && Number.isFinite(m) && m > 0;
}

function hoyISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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

// POST /api/honorarios/generar — genera los honorarios del mes (default: mes actual) a
// partir de los planes activos del estudio. Idempotente.
export async function generarHonorariosEndpoint(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id!;
  const { anio: anioRaw, mes: mesRaw } = (req.body ?? {}) as { anio?: unknown; mes?: unknown };
  const now = new Date();

  let anio: number;
  if (anioRaw === undefined) {
    anio = now.getFullYear();
  } else if (Number.isInteger(anioRaw) && (anioRaw as number) >= 2024 && (anioRaw as number) <= 2100) {
    anio = anioRaw as number;
  } else {
    res.status(400).json({ error: 'anio debe ser un entero entre 2024 y 2100' });
    return;
  }

  let mes: number;
  if (mesRaw === undefined) {
    mes = now.getMonth() + 1;
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
        await generarHonorarioClienteMesActual({
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
