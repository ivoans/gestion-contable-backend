import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendVencido, sendRecordatorio } from '../services/emailService';
import { entregarNotificacion } from '../services/notificacionesService';

function getDateAR(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

type ImpuestoVencido = {
  id: string;
  cliente_id: string;
  creado_por: string;
  tipo: string;
  cliente: { nombre: string } | null;
  contador: { email: string } | null;
};

type ImpuestoRecordatorio = {
  id: string;
  cliente_id: string;
  tipo: string;
  fecha_vencimiento: string;
  cliente: { email: string; nombre: string };
};

export async function procesarVencidos(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[cron:vencidos] START ${ts}`);

  const today = getDateAR();

  // Paso 1 — transición de estado, DESACOPLADA del envío (B3). Marca 'vencido' todos los
  // pendientes pasados de fecha de una. Idempotente; si falla, igual seguimos al aviso.
  const { error: transError } = await supabase
    .from('impuestos')
    .update({ estado: 'vencido' })
    .eq('estado', 'pendiente')
    .lt('fecha_vencimiento', today);

  if (transError) {
    console.error('[cron:vencidos] Error en transición a vencido:', transError.message);
  }

  // Paso 2 — avisar al CONTADOR (creado_por, B2) por cada impuesto vencido. Se re-evalúan
  // todos los vencidos: entregarNotificacion saltea los ya 'enviada' y reintenta los
  // 'pendiente'/'fallida' (esos eran los que antes se perdían para siempre).
  const { data: vencidos, error } = await supabase
    .from('impuestos')
    .select('id, cliente_id, creado_por, tipo, cliente:users!cliente_id(nombre), contador:users!creado_por(email)')
    .eq('estado', 'vencido')
    .lt('fecha_vencimiento', today);

  if (error) {
    console.error('[cron:vencidos] Error buscando vencidos:', error.message);
    return;
  }

  if (!vencidos || vencidos.length === 0) {
    console.log('[cron:vencidos] Sin impuestos vencidos. END');
    return;
  }

  let enviados = 0;
  let fallidos = 0;

  for (const impuesto of vencidos as unknown as ImpuestoVencido[]) {
    const emailContador = impuesto.contador?.email;
    if (!emailContador) {
      console.error(`[cron:vencidos] Impuesto ${impuesto.id} sin email de contador (creado_por=${impuesto.creado_por}); se omite.`);
      continue;
    }

    const resultado = await entregarNotificacion({
      target: { impuesto_id: impuesto.id },
      user_id: impuesto.creado_por,
      tipo: 'vencido',
      enviar: () =>
        sendVencido(emailContador, {
          nombre_cliente: impuesto.cliente?.nombre ?? '',
          tipo: impuesto.tipo,
        }),
    });

    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  }

  console.log(`[cron:vencidos] Enviados ${enviados}, fallidos ${fallidos}, total ${vencidos.length}. END ${new Date().toISOString()}`);
}

export async function procesarRecordatorios(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[cron:recordatorios] START ${ts}`);

  const today = getDateAR();
  const targetDate = addDays(today, 3);

  const { data: proximos, error } = await supabase
    .from('impuestos')
    .select('id, cliente_id, tipo, fecha_vencimiento, cliente:users!cliente_id(email, nombre)')
    .eq('estado', 'pendiente')
    .eq('fecha_vencimiento', targetDate);

  if (error) {
    console.error('[cron:recordatorios] Error buscando próximos:', error.message);
    return;
  }

  if (!proximos || proximos.length === 0) {
    console.log('[cron:recordatorios] Sin recordatorios para enviar. END');
    return;
  }

  let enviados = 0;
  let fallidos = 0;

  // El recordatorio va al CLIENTE (le avisamos que su impuesto vence en 3 días). La capa
  // de entrega saltea los ya 'enviada' y reintenta 'pendiente'/'fallida'.
  for (const impuesto of proximos as unknown as ImpuestoRecordatorio[]) {
    const resultado = await entregarNotificacion({
      target: { impuesto_id: impuesto.id },
      user_id: impuesto.cliente_id,
      tipo: 'recordatorio_3dias',
      enviar: () =>
        sendRecordatorio(impuesto.cliente.email, {
          nombre: impuesto.cliente.nombre,
          tipo: impuesto.tipo,
          fecha_vencimiento: impuesto.fecha_vencimiento,
        }),
    });

    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  }

  console.log(`[cron:recordatorios] Enviados ${enviados}, fallidos ${fallidos}, total ${proximos.length}. END ${new Date().toISOString()}`);
}

export async function runVencimientosCron(): Promise<void> {
  await procesarVencidos();
}

export function initCronJobs(): void {
  cron.schedule('0 8 * * *', async () => {
    try {
      await procesarVencidos();
    } catch (err) {
      console.error('[cron:vencidos] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  cron.schedule('0 8 * * *', async () => {
    try {
      await procesarRecordatorios();
    } catch (err) {
      console.error('[cron:recordatorios] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('[cron] Jobs inicializados — vencidos + recordatorios @ 08:00 ART');
}
