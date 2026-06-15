import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { generarHonorarios } from '../services/honorariosService';

function getDateAR(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

// Marca como 'vencido' los honorarios pendientes cuya fecha ya pasó. Sin email (los
// avisos llegan por push en la Feature 3).
export async function procesarHonorariosVencidos(): Promise<void> {
  const today = getDateAR();
  console.log(`[cron:honorarios-vencidos] START ${today}`);

  const { data, error } = await supabase
    .from('honorarios')
    .update({ estado: 'vencido' })
    .eq('estado', 'pendiente')
    .lt('fecha_vencimiento', today)
    .select('id');

  if (error) {
    console.error('[cron:honorarios-vencidos] Error:', error.message);
    return;
  }

  console.log(`[cron:honorarios-vencidos] Marcados ${data?.length ?? 0}. END`);
}

// Genera los honorarios del mes actual para TODOS los estudios (a partir de los planes
// activos). Idempotente: re-correr el mismo mes no duplica.
export async function generarHonorariosMesActual(): Promise<void> {
  const now = new Date();
  const anio = now.getFullYear();
  const mes = now.getMonth() + 1;
  console.log(`[cron:honorarios-generar] START ${anio}-${mes}`);

  const result = await generarHonorarios({ anio, mes, creado_por: null });
  if ('error' in result) {
    console.error('[cron:honorarios-generar] Error:', result.error);
    return;
  }

  console.log(`[cron:honorarios-generar] creados=${result.creados} ya_existentes=${result.ya_existentes} reactivados=${result.reactivados}. END`);
}

export function initHonorariosJobs(): void {
  // Generación: día 1 de cada mes a las 08:00 ART.
  cron.schedule('0 8 1 * *', async () => {
    try {
      await generarHonorariosMesActual();
    } catch (err) {
      console.error('[cron:honorarios-generar] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Vencidos: todos los días a las 08:00 ART.
  cron.schedule('0 8 * * *', async () => {
    try {
      await procesarHonorariosVencidos();
    } catch (err) {
      console.error('[cron:honorarios-vencidos] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('[cron] Jobs de honorarios inicializados — generar @ día 1 + vencidos diario, 08:00 ART');
}
