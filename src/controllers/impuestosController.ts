import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { Impuesto, EstadoImpuesto, Obligacion, CondicionFiscal } from '../types';
import { sendNuevoImpuesto } from '../services/emailService';
import { isValidCuit, normalizeCuit } from '../utils/validators';

export async function crearImpuesto(req: Request, res: Response): Promise<void> {
  const { cliente_id, tipo, monto, fecha_vencimiento, descripcion, vep } = req.body as {
    cliente_id?: string;
    tipo?: string;
    monto?: number;
    fecha_vencimiento?: string;
    descripcion?: string;
    vep?: string;
  };

  if (!cliente_id || !tipo || monto === undefined || !fecha_vencimiento) {
    res.status(400).json({ error: 'cliente_id, tipo, monto y fecha_vencimiento son requeridos' });
    return;
  }

  if (tipo.length > 100) {
    res.status(400).json({ error: 'El tipo no puede superar 100 caracteres' });
    return;
  }

  if (typeof monto !== 'number' || !Number.isFinite(monto) || monto <= 0) {
    res.status(400).json({ error: 'monto debe ser un número positivo' });
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento) || isNaN(Date.parse(fecha_vencimiento))) {
    res.status(400).json({ error: 'Fecha de vencimiento debe tener formato YYYY-MM-DD' });
    return;
  }

  // vep: string opcional. Trim; vacío → null. Largo acotado (igual que en PATCH).
  let vepNormalizado: string | null = null;
  if (vep !== undefined) {
    if (typeof vep !== 'string') {
      res.status(400).json({ error: 'vep debe ser un string' });
      return;
    }
    const trimmed = vep.trim();
    if (trimmed.length > 100) {
      res.status(400).json({ error: 'vep no puede superar 100 caracteres' });
      return;
    }
    vepNormalizado = trimmed === '' ? null : trimmed;
  }

  const estudio_id = req.user!.estudio_id;

  try {
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
      .from('impuestos')
      .insert({
        estudio_id,
        cliente_id,
        creado_por: req.user!.id,
        tipo,
        monto,
        fecha_vencimiento,
        descripcion: descripcion ?? null,
        vep: vepNormalizado,
        estado: 'pendiente',
      })
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const nuevoImpuesto = data as Impuesto;

    try {
      const { data: clienteData } = await supabase
        .from('users')
        .select('email, nombre')
        .eq('id', cliente_id)
        .single();

      if (clienteData) {
        await sendNuevoImpuesto(clienteData.email, {
          nombre: clienteData.nombre,
          tipo: nuevoImpuesto.tipo,
          monto: nuevoImpuesto.monto,
          fecha_vencimiento: nuevoImpuesto.fecha_vencimiento,
        });

        await supabase.from('notificaciones').insert({
          impuesto_id: nuevoImpuesto.id,
          user_id: cliente_id,
          tipo: 'nuevo',
          canal: 'email',
        });
      }
    } catch (emailErr) {
      console.error('[crearImpuesto] Email fail, impuesto creado OK:', emailErr);
    }

    res.status(201).json(nuevoImpuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

const ESTADOS_VALIDOS: EstadoImpuesto[] = ['pendiente', 'vencido', 'pagado'];

export async function listarImpuestos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, estado } = req.query as { cliente_id?: string; estado?: string };

  if (estado && !ESTADOS_VALIDOS.includes(estado as EstadoImpuesto)) {
    res.status(400).json({ error: 'estado debe ser pendiente, vencido o pagado' });
    return;
  }

  try {
    let query = supabase
      .from('impuestos')
      .select('*')
      .eq('estudio_id', estudio_id)
      .order('fecha_vencimiento', { ascending: true });

    if (cliente_id) query = query.eq('cliente_id', cliente_id);
    if (estado) query = query.eq('estado', estado as EstadoImpuesto);

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Impuesto[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function obtenerImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('impuestos')
      .select('*')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function actualizarImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { tipo, monto, fecha_vencimiento, descripcion, vep } = req.body as {
    tipo?: string;
    monto?: number;
    fecha_vencimiento?: string;
    descripcion?: string;
    vep?: string;
  };

  if (fecha_vencimiento !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento) || isNaN(Date.parse(fecha_vencimiento)))) {
    res.status(400).json({ error: 'Fecha de vencimiento debe tener formato YYYY-MM-DD' });
    return;
  }

  if (monto !== undefined && (typeof monto !== 'number' || !Number.isFinite(monto) || monto <= 0)) {
    res.status(400).json({ error: 'monto debe ser un número positivo' });
    return;
  }

  // vep: string opcional. Trim; vacío → null (permite limpiarlo). Largo acotado.
  let vepNormalizado: string | null | undefined;
  if (vep !== undefined) {
    if (typeof vep !== 'string') {
      res.status(400).json({ error: 'vep debe ser un string' });
      return;
    }
    const trimmed = vep.trim();
    if (trimmed.length > 100) {
      res.status(400).json({ error: 'vep no puede superar 100 caracteres' });
      return;
    }
    vepNormalizado = trimmed === '' ? null : trimmed;
  }

  const updates: Partial<Record<string, unknown>> = {};
  if (tipo !== undefined) updates.tipo = tipo;
  if (monto !== undefined) updates.monto = monto;
  if (fecha_vencimiento !== undefined) updates.fecha_vencimiento = fecha_vencimiento;
  if (descripcion !== undefined) updates.descripcion = descripcion;
  if (vepNormalizado !== undefined) updates.vep = vepNormalizado;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    return;
  }

  try {
    const { data: existing, error: findError } = await supabase
      .from('impuestos')
      .select('id, estado, monto')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    const actual = existing as { id: string; estado: EstadoImpuesto; monto: number | null };

    if (actual.estado === 'pagado') {
      res.status(400).json({ error: 'No se puede editar un impuesto pagado' });
      return;
    }

    // Completar borrador: si tras el PATCH queda con monto válido (>0), pasa a
    // 'pendiente'. Si sigue sin monto válido, queda en 'borrador'. Sin monto NO
    // se transiciona: violaría chk_monto_por_estado.
    if (actual.estado === 'borrador') {
      const montoEfectivo = monto !== undefined ? monto : actual.monto;
      if (montoEfectivo !== null && montoEfectivo > 0) {
        updates.estado = 'pendiente';
      }
    }

    const { data, error } = await supabase
      .from('impuestos')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function cambiarEstadoImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('impuestos')
      .select('id, estado')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    const estadoActual = (existing as { id: string; estado: EstadoImpuesto }).estado;

    if (estadoActual === 'pagado') {
      res.status(400).json({ error: 'El impuesto ya está pagado' });
      return;
    }

    // Un borrador (monto null) no puede ir directo a 'pagado': violaría
    // chk_monto_por_estado en la DB (500). Solo pasa a 'pendiente' vía PATCH /:id
    // al cargarle el monto. Rechazamos acá, antes de tocar la base.
    if (estadoActual === 'borrador') {
      res.status(400).json({
        error: 'Un borrador no se puede cambiar de estado; cargá el monto para pasarlo a pendiente',
      });
      return;
    }

    const { data, error } = await supabase
      .from('impuestos')
      .update({
        estado: 'pagado',
        pagado_at: new Date().toISOString(),
        pagado_por: req.user!.id,
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function misImpuestos(req: Request, res: Response): Promise<void> {
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('impuestos')
      .select('*')
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .neq('estado', 'borrador') // el cliente no ve borradores, solo pendiente/vencido/pagado
      .order('fecha_vencimiento', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const impuestos = data as Impuesto[];
    res.json({
      pendientes: impuestos.filter((i) => i.estado === 'pendiente'),
      vencidos: impuestos.filter((i) => i.estado === 'vencido'),
      pagados: impuestos.filter((i) => i.estado === 'pagado'),
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function miImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('impuestos')
      .select('*')
      .eq('id', id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── Generación automática de impuestos en borrador ──────────────────────────

const ANIO_MIN = 2024;
const ANIO_MAX = 2100;

// Obligaciones mensuales según la condición fiscal del cliente.
// Debe coincidir EXACTO con el config del calendario en el front.
const OBLIGACIONES_POR_CONDICION: Record<CondicionFiscal, Obligacion[]> = {
  monotributista: ['monotributo', 'ingresos_brutos'],
  responsable_inscripto: ['iva', 'autonomos', 'ingresos_brutos'],
};

// Obligaciones cuyo vencimiento sale por último dígito del CUIT. El resto se
// busca en el calendario con terminacion_cuit = null ("Todos").
const OBLIGACIONES_POR_DIGITO: ReadonlySet<Obligacion> = new Set<Obligacion>(['iva', 'autonomos']);

// Etiqueta legible que se guarda en la columna `tipo` del impuesto.
const TIPO_LABEL: Record<Obligacion, string> = {
  monotributo: 'Monotributo',
  iva: 'IVA',
  autonomos: 'Autónomos',
  ingresos_brutos: 'Ingresos Brutos',
};

type ClienteFiscal = {
  id: string;
  nombre: string;
  cuit: string | null;
  condicion_fiscal: CondicionFiscal | null;
};

type VencimientoCalendario = {
  obligacion: Obligacion;
  terminacion_cuit: number | null;
  fecha_vencimiento: string;
};

type ClienteSalteado = { cliente_id: string; nombre: string; motivo: string };
type ObligacionSinFecha = { cliente_id: string; nombre: string; obligacion: Obligacion };

function calendarKey(obligacion: Obligacion, terminacion: number | null): string {
  return `${obligacion}|${terminacion === null ? 'all' : terminacion}`;
}

// POST /api/impuestos/generar — crea los borradores mensuales por condición fiscal.
export async function generarImpuestos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { anio: anioRaw, mes: mesRaw } = (req.body ?? {}) as { anio?: unknown; mes?: unknown };

  const now = new Date();

  let anio: number;
  if (anioRaw === undefined) {
    anio = now.getFullYear();
  } else if (Number.isInteger(anioRaw) && (anioRaw as number) >= ANIO_MIN && (anioRaw as number) <= ANIO_MAX) {
    anio = anioRaw as number;
  } else {
    res.status(400).json({ error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}` });
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

  const periodo = `${anio}-${String(mes).padStart(2, '0')}-01`;

  try {
    // 1. Clientes activos del estudio con su clasificación fiscal.
    const { data: clientesData, error: clientesError } = await supabase
      .from('users')
      .select('id, nombre, cuit, condicion_fiscal')
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .eq('activo', true);

    if (clientesError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    // 2. Calendario del estudio para ese (anio, mes). Lo indexamos en memoria
    //    por obligacion + terminacion para no pegarle una query por cliente.
    const { data: vencimientosData, error: vencimientosError } = await supabase
      .from('vencimientos')
      .select('obligacion, terminacion_cuit, fecha_vencimiento')
      .eq('estudio_id', estudio_id)
      .eq('anio', anio)
      .eq('mes', mes);

    if (vencimientosError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const calendario = new Map<string, string>();
    for (const v of (vencimientosData ?? []) as VencimientoCalendario[]) {
      calendario.set(calendarKey(v.obligacion, v.terminacion_cuit), v.fecha_vencimiento);
    }

    const clientes_salteados: ClienteSalteado[] = [];
    const obligaciones_sin_fecha: ObligacionSinFecha[] = [];
    const rows: Array<Record<string, unknown>> = [];

    for (const c of (clientesData ?? []) as ClienteFiscal[]) {
      if (!c.condicion_fiscal) {
        clientes_salteados.push({ cliente_id: c.id, nombre: c.nombre, motivo: 'Sin condición fiscal' });
        continue;
      }

      const cuitNormalizado = normalizeCuit(c.cuit);
      if (!cuitNormalizado || !isValidCuit(c.cuit)) {
        clientes_salteados.push({ cliente_id: c.id, nombre: c.nombre, motivo: 'CUIT inválido' });
        continue;
      }

      for (const obligacion of OBLIGACIONES_POR_CONDICION[c.condicion_fiscal]) {
        const terminacion = OBLIGACIONES_POR_DIGITO.has(obligacion)
          ? Number(cuitNormalizado[10])
          : null;

        const fecha = calendario.get(calendarKey(obligacion, terminacion));
        if (!fecha) {
          obligaciones_sin_fecha.push({ cliente_id: c.id, nombre: c.nombre, obligacion });
          continue;
        }

        rows.push({
          estudio_id,
          cliente_id: c.id,
          creado_por: req.user!.id,
          tipo: TIPO_LABEL[obligacion],
          obligacion,
          periodo,
          fecha_vencimiento: fecha,
          estado: 'borrador',
          monto: null,
          vep: null,
        });
      }
    }

    // 3. Insert idempotente: ON CONFLICT DO NOTHING sobre el índice parcial
    //    (cliente_id, obligacion, periodo). `select` devuelve solo las filas
    //    realmente insertadas → el resto ya existía.
    let creados = 0;
    if (rows.length > 0) {
      const { data: insertData, error: insertError } = await supabase
        .from('impuestos')
        .upsert(rows, { onConflict: 'cliente_id, obligacion, periodo', ignoreDuplicates: true })
        .select('id');

      if (insertError || !insertData) {
        res.status(500).json({ error: 'Error interno del servidor' });
        return;
      }

      creados = insertData.length;
    }

    res.json({
      anio,
      mes,
      creados,
      ya_existentes: rows.length - creados,
      clientes_salteados,
      obligaciones_sin_fecha,
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
