import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { sendVencido } from '../services/emailService';
import { Impuesto } from '../types';

async function procesarVencimientos() {
  const now = new Date().toISOString();

  const { data: vencidos, error } = await supabase
    .from('impuestos')
    .select('*, cliente:users!cliente_id(email, nombre)')
    .eq('estado', 'pendiente')
    .lt('fecha_vencimiento', now);

  if (error) {
    console.error('[cron] Error buscando vencidos:', error.message);
    return;
  }

  if (!vencidos || vencidos.length === 0) return;

  for (const impuesto of vencidos as (Impuesto & { cliente: { email: string; nombre: string } })[]) {
    const { error: updateError } = await supabase
      .from('impuestos')
      .update({ estado: 'vencido', updated_at: now })
      .eq('id', impuesto.id);

    if (updateError) {
      console.error(`[cron] Error actualizando impuesto ${impuesto.id}:`, updateError.message);
      continue;
    }

    const { data: notifExistente } = await supabase
      .from('notificaciones')
      .select('id')
      .eq('impuesto_id', impuesto.id)
      .eq('tipo', 'vencido')
      .maybeSingle();

    if (notifExistente) continue;

    try {
      const emails = [impuesto.cliente.email];
      await sendVencido(emails, {
        nombre: impuesto.cliente.nombre,
        tipo: impuesto.tipo,
      });

      await supabase.from('notificaciones').insert({
        impuesto_id: impuesto.id,
        user_id: impuesto.cliente_id,
        tipo: 'vencido',
        canal: 'email',
        enviada_at: now,
      });
    } catch (emailError) {
      console.error(`[cron] Error enviando email para impuesto ${impuesto.id}:`, emailError);
    }
  }

  console.log(`[cron] Procesados ${vencidos.length} impuesto(s) vencido(s)`);
}

export function initCronJobs() {
  cron.schedule('0 8 * * *', procesarVencimientos, {
    timezone: 'America/Argentina/Buenos_Aires',
  });

  console.log('[cron] Jobs inicializados');
}
