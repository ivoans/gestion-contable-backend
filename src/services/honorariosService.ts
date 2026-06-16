import { supabase } from '../lib/supabase';

const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

type PlanRow = {
  cliente_id: string;
  estudio_id: string;
  monto: number;
  dia_vencimiento: number;
  cliente: { activo: boolean } | null;
};

export interface GenerarHonorariosResult {
  anio: number;
  mes: number;
  creados: number;
  ya_existentes: number;
  reactivados: number;
}

/**
 * Reactiva (anulado → pendiente) los honorarios del período para los clientes dados,
 * actualizando monto/fecha con los valores del plan. Devuelve cuántos revivió.
 * Sin esto, un honorario anulado bloquea para siempre su (cliente_id, periodo): el
 * UNIQUE impide recrearlo y queda oculto en el front.
 */
async function revivirAnulados(
  periodo: string,
  porCliente: Map<string, { monto: number; fecha_vencimiento: string }>,
): Promise<number> {
  const clienteIds = [...porCliente.keys()];
  if (clienteIds.length === 0) return 0;

  const { data: anulados, error } = await supabase
    .from('honorarios')
    .select('id, cliente_id')
    .eq('periodo', periodo)
    .eq('estado', 'anulado')
    .in('cliente_id', clienteIds);

  if (error || !anulados || anulados.length === 0) return 0;

  let revividos = 0;
  for (const row of anulados as { id: string; cliente_id: string }[]) {
    const plan = porCliente.get(row.cliente_id);
    if (!plan) continue;
    const { error: updErr } = await supabase
      .from('honorarios')
      .update({
        estado: 'pendiente',
        monto: plan.monto,
        fecha_vencimiento: plan.fecha_vencimiento,
        pagado_at: null,
        pagado_por: null,
      })
      .eq('id', row.id);
    if (!updErr) revividos += 1;
  }
  return revividos;
}

/**
 * Genera los honorarios del período (anio, mes) a partir de los planes activos.
 *  - estudio_id: si se pasa, solo ese estudio (endpoint del contador). Si no, todos
 *    los estudios (cron mensual).
 *  - creado_por: id del contador en el alta manual; null cuando lo dispara el cron.
 *
 * Idempotente: UNIQUE (cliente_id, periodo) + upsert ignoreDuplicates → re-correr el
 * mismo mes no duplica (devuelve ya_existentes).
 */
export async function generarHonorarios(opts: {
  estudio_id?: string;
  anio: number;
  mes: number;
  creado_por?: string | null;
}): Promise<GenerarHonorariosResult | { error: string }> {
  const { estudio_id, anio, mes } = opts;
  const mm = String(mes).padStart(2, '0');
  const periodo = `${anio}-${mm}-01`;

  let query = supabase
    .from('honorarios_plan')
    .select('cliente_id, estudio_id, monto, dia_vencimiento, cliente:users!cliente_id(activo)')
    .eq('activo', true);
  if (estudio_id) query = query.eq('estudio_id', estudio_id);

  const { data, error } = await query;
  if (error) return { error: error.message };

  const planes = (data ?? []) as unknown as PlanRow[];

  const rows = planes
    // Cliente activo (si el join no trajo el user, lo tratamos como activo igual).
    .filter((p) => p.cliente?.activo !== false)
    .map((p) => ({
      estudio_id: p.estudio_id,
      cliente_id: p.cliente_id,
      creado_por: opts.creado_por ?? null,
      periodo,
      monto: p.monto,
      fecha_vencimiento: `${anio}-${mm}-${String(p.dia_vencimiento).padStart(2, '0')}`,
      descripcion: `Honorarios ${MESES_ES[mes - 1]} ${anio}`,
      estado: 'pendiente' as const,
    }));

  if (rows.length === 0) return { anio, mes, creados: 0, ya_existentes: 0, reactivados: 0 };

  const { data: inserted, error: insErr } = await supabase
    .from('honorarios')
    .upsert(rows, { onConflict: 'cliente_id, periodo', ignoreDuplicates: true })
    .select('id');

  if (insErr || !inserted) return { error: insErr?.message ?? 'Error insertando honorarios' };

  // Los que ya existían pueden estar anulados: revivirlos para que vuelvan a aparecer.
  const porCliente = new Map(rows.map((r) => [r.cliente_id, { monto: r.monto, fecha_vencimiento: r.fecha_vencimiento }]));
  const reactivados = await revivirAnulados(periodo, porCliente);

  return {
    anio,
    mes,
    creados: inserted.length,
    ya_existentes: rows.length - inserted.length - reactivados,
    reactivados,
  };
}

/**
 * Genera el honorario del MES ACTUAL para un cliente puntual. Se usa al crear/editar
 * el plan, así el honorario aparece al instante sin esperar al cron ni a "Generar mes".
 * Idempotente: si el del mes ya existe, no lo toca (ignoreDuplicates).
 */
export async function generarHonorarioClienteMesActual(opts: {
  estudio_id: string;
  cliente_id: string;
  monto: number;
  dia_vencimiento: number;
  creado_por?: string | null;
}): Promise<void> {
  const now = new Date();
  const anio = now.getFullYear();
  const mes = now.getMonth() + 1;
  const mm = String(mes).padStart(2, '0');
  const periodo = `${anio}-${mm}-01`;
  const fecha_vencimiento = `${anio}-${mm}-${String(opts.dia_vencimiento).padStart(2, '0')}`;

  await supabase.from('honorarios').upsert(
    {
      estudio_id: opts.estudio_id,
      cliente_id: opts.cliente_id,
      creado_por: opts.creado_por ?? null,
      periodo,
      monto: opts.monto,
      fecha_vencimiento,
      descripcion: `Honorarios ${MESES_ES[mes - 1]} ${anio}`,
      estado: 'pendiente',
    },
    { onConflict: 'cliente_id, periodo', ignoreDuplicates: true },
  );

  // Si ya existía pero estaba anulado, revivirlo (misma lógica que "Generar mes").
  await revivirAnulados(periodo, new Map([[opts.cliente_id, { monto: opts.monto, fecha_vencimiento }]]));
}
