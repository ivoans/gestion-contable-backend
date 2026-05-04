import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendVencido, sendRecordatorio } from '../services/emailService';

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
  cliente: { email: string; nombre: string };
  contador: { email: string };
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

  const { data: vencidos, error } = await supabase
    .from('impuestos')
    .select('id, cliente_id, creado_por, tipo, cliente:users!cliente_id(email, nombre), contador:users!creado_por(email)')
    .eq('estado', 'pendiente')
    .lt('fecha_vencimiento', today);

  if (error) {
    console.error('[cron:vencidos] Error buscando vencidos:', error.message);
    return;
  }

  if (!vencidos || vencidos.length === 0) {
    console.log('[cron:vencidos] Sin impuestos vencidos. END');
    return;
  }

  let procesados = 0;

  for (const impuesto of vencidos as unknown as ImpuestoVencido[]) {
    const { data: notifExistente } = await supabase
      .from('notificaciones')
      .select('id')
      .eq('impuesto_id', impuesto.id)
      .eq('tipo', 'vencido')
      .maybeSingle();

    if (notifExistente) continue;

    const { error: updateError } = await supabase
      .from('impuestos')
      .update({ estado: 'vencido' })
      .eq('id', impuesto.id);

    if (updateError) {
      console.error(`[cron:vencidos] Error actualizando ${impuesto.id}:`, updateError.message);
      continue;
    }

    try {
      await sendVencido(
        [impuesto.cliente.email, impuesto.contador.email],
        { nombre_cliente: impuesto.cliente.nombre, tipo: impuesto.tipo }
      );

      await supabase.from('notificaciones').insert([
        { impuesto_id: impuesto.id, user_id: impuesto.cliente_id, tipo: 'vencido', canal: 'email' },
        { impuesto_id: impuesto.id, user_id: impuesto.creado_por, tipo: 'vencido', canal: 'email' },
      ]);

      procesados++;
    } catch (emailErr) {
      console.error(`[cron:vencidos] Email fail impuesto ${impuesto.id}:`, emailErr);
    }
  }

  console.log(`[cron:vencidos] Procesados ${procesados}/${vencidos.length}. END ${new Date().toISOString()}`);
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

  for (const impuesto of proximos as unknown as ImpuestoRecordatorio[]) {
    const { data: notifExistente } = await supabase
      .from('notificaciones')
      .select('id')
      .eq('impuesto_id', impuesto.id)
      .eq('tipo', 'recordatorio_3dias')
      .maybeSingle();

    if (notifExistente) continue;

    try {
      await sendRecordatorio(impuesto.cliente.email, {
        nombre: impuesto.cliente.nombre,
        tipo: impuesto.tipo,
        fecha_vencimiento: impuesto.fecha_vencimiento,
      });

      await supabase.from('notificaciones').insert({
        impuesto_id: impuesto.id,
        user_id: impuesto.cliente_id,
        tipo: 'recordatorio_3dias',
        canal: 'email',
      });

      enviados++;
    } catch (emailErr) {
      console.error(`[cron:recordatorios] Email fail impuesto ${impuesto.id}:`, emailErr);
    }
  }

  console.log(`[cron:recordatorios] Enviados ${enviados}/${proximos.length}. END ${new Date().toISOString()}`);
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
