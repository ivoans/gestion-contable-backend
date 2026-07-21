// Estado de cuenta / cuenta corriente: agrega la deuda de un cliente (impuestos +
// honorarios) en memoria, sin persistir. Molde: resumenHonorarios (suma por estado)
// + tipos no-persistidos estilo ResumenLibroIVA.
import { supabase } from '../lib/supabase';
import { DeudaItem, BloqueDeuda, Aging, EstadoCuenta, CobranzaCliente } from '../types';
import { getDateAR, formatPeriodoLargo } from '../utils/fechas';

// Deuda = obligaciones vivas. Impuestos: excluye 'borrador' (sin monto) y 'pagado'.
// Honorarios: excluye 'anulado' y 'pagado'. Ambos quedan en pendiente/vencido.
const OUTSTANDING = ['pendiente', 'vencido'];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Días transcurridos desde el vencimiento hasta hoy (mediodía UTC para esquivar DST,
// igual que utils/fechas.addDays). >0 = ya venció; <=0 = todavía no.
function diasVencido(fechaVencimiento: string, hoy: string): number {
  const ms =
    new Date(`${hoy}T12:00:00Z`).getTime() -
    new Date(`${fechaVencimiento}T12:00:00Z`).getTime();
  return Math.floor(ms / 86_400_000);
}

function emptyAging(): Aging {
  return { por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_mas: 0 };
}

// Suma un monto al bucket de aging que le corresponde por antigüedad de vencimiento.
function acumularAging(aging: Aging, fechaVencimiento: string, monto: number, hoy: string): void {
  const d = diasVencido(fechaVencimiento, hoy);
  const bucket: keyof Aging =
    d <= 0 ? 'por_vencer' : d <= 30 ? 'd0_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90_mas';
  aging[bucket] = round2(aging[bucket] + monto);
}

type HonorarioDeuda = { fecha_vencimiento: string; monto: number };

function agingDe(honorarios: HonorarioDeuda[], hoy: string): Aging {
  const aging = emptyAging();
  for (const h of honorarios) acumularAging(aging, h.fecha_vencimiento, Number(h.monto), hoy);
  return aging;
}

// Concepto legible del honorario: período ("Honorarios junio 2026") o su descripción (suelto).
function conceptoHonorario(periodo: string | null, descripcion: string | null): string {
  if (periodo) return `Honorarios ${formatPeriodoLargo(periodo)}`;
  return descripcion ?? 'Honorarios';
}

/** Estado de cuenta de un cliente: bloques Impuestos + Estudio, total y aging (solo estudio). */
export async function armarEstadoCuenta(estudioId: string, clienteId: string): Promise<EstadoCuenta> {
  const hoy = getDateAR();

  const { data: impData, error: impErr } = await supabase
    .from('impuestos')
    .select('id, tipo, fecha_vencimiento, monto, estado')
    .eq('estudio_id', estudioId)
    .eq('cliente_id', clienteId)
    .in('estado', OUTSTANDING)
    .order('fecha_vencimiento', { ascending: true });
  if (impErr) throw impErr;

  const { data: honData, error: honErr } = await supabase
    .from('honorarios')
    .select('id, periodo, descripcion, fecha_vencimiento, monto, estado')
    .eq('estudio_id', estudioId)
    .eq('cliente_id', clienteId)
    .in('estado', OUTSTANDING)
    .order('fecha_vencimiento', { ascending: true });
  if (honErr) throw honErr;

  const impItems: DeudaItem[] = ((impData ?? []) as any[]).map((i) => ({
    id: i.id,
    origen: 'impuesto',
    concepto: i.tipo,
    fecha_vencimiento: i.fecha_vencimiento,
    monto: Number(i.monto),
    estado: i.estado,
    dias_vencido: Math.max(0, diasVencido(i.fecha_vencimiento, hoy)),
  }));

  const honFilas = (honData ?? []) as any[];
  const honItems: DeudaItem[] = honFilas.map((h) => ({
    id: h.id,
    origen: 'honorario',
    concepto: conceptoHonorario(h.periodo, h.descripcion),
    fecha_vencimiento: h.fecha_vencimiento,
    monto: Number(h.monto),
    estado: h.estado,
    dias_vencido: Math.max(0, diasVencido(h.fecha_vencimiento, hoy)),
  }));

  const impuestos: BloqueDeuda = {
    items: impItems,
    subtotal: round2(impItems.reduce((s, i) => s + i.monto, 0)),
  };
  const estudio: BloqueDeuda = {
    items: honItems,
    subtotal: round2(honItems.reduce((s, i) => s + i.monto, 0)),
  };

  return {
    cliente_id: clienteId,
    impuestos,
    estudio,
    total: round2(impuestos.subtotal + estudio.subtotal),
    aging: agingDe(honFilas, hoy),
    generado_at: hoy,
  };
}

/**
 * Dashboard global de cobranzas del estudio: todos los clientes con honorarios adeudados,
 * con saldo + aging por cliente, ordenados por saldo descendente. Solo honorarios (la
 * plata que le deben al estudio); los impuestos son deuda con terceros, no entran acá.
 */
export async function armarCobranzas(estudioId: string): Promise<CobranzaCliente[]> {
  const hoy = getDateAR();

  const { data, error } = await supabase
    .from('honorarios')
    .select('cliente_id, monto, fecha_vencimiento, estado, cliente:users!cliente_id(id, nombre, telefono)')
    .eq('estudio_id', estudioId)
    .in('estado', OUTSTANDING);
  if (error) throw error;

  const porCliente = new Map<string, CobranzaCliente>();
  for (const h of (data ?? []) as any[]) {
    // El join embebido puede venir como objeto (FK 1-1) o array según supabase-js.
    const cli = Array.isArray(h.cliente) ? h.cliente[0] : h.cliente;
    let entry = porCliente.get(h.cliente_id);
    if (!entry) {
      entry = {
        cliente_id: h.cliente_id,
        nombre: cli?.nombre ?? '—',
        telefono: cli?.telefono ?? null,
        saldo: 0,
        aging: emptyAging(),
      };
      porCliente.set(h.cliente_id, entry);
    }
    const monto = Number(h.monto);
    entry.saldo = round2(entry.saldo + monto);
    acumularAging(entry.aging, h.fecha_vencimiento, monto, hoy);
  }

  return [...porCliente.values()].sort((a, b) => b.saldo - a.saldo);
}
