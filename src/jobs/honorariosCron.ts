import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import { generarHonorarios } from '../services/honorariosService';
import {
  sendNuevoHonorario,
  sendRecordatorioHonorario,
  sendHonorarioVencidoCliente,
} from '../services/emailService';
import { sendPushToUser } from '../services/pushService';
import { entregarNotificacion } from '../services/notificacionesService';
import { getDateAR, addDays, periodoAnteriorAR, formatFechaCorta } from '../utils/fechas';

type HonorarioAviso = {
  id: string;
  cliente_id: string;
  monto: number;
  descripcion: string | null;
  fecha_vencimiento: string;
  cliente: { nombre: string; email: string } | null;
};

const SELECT_AVISO = 'id, cliente_id, monto, descripcion, fecha_vencimiento, cliente:users!cliente_id(nombre, email)';

function descripcionDe(honorario: HonorarioAviso): string {
  return honorario.descripcion ?? 'Honorarios';
}

// Marca como 'vencido' los honorarios pendientes cuya fecha ya pasó y avisa al CLIENTE
// (email + push) con el mismo mecanismo de dedup/reintento que los impuestos.
export async function procesarHonorariosVencidos(): Promise<void> {
  const today = getDateAR();
  console.log(`[cron:honorarios-vencidos] START ${today}`);

  // Paso 1 — transición de estado, desacoplada del envío (mismo patrón que impuestos).
  const { error: transError } = await supabase
    .from('honorarios')
    .update({ estado: 'vencido' })
    .eq('estado', 'pendiente')
    .lt('fecha_vencimiento', today);

  if (transError) {
    console.error('[cron:honorarios-vencidos] Error en transición a vencido:', transError.message);
  }

  // Paso 2 — avisar. Acotado a 30 días hacia atrás: los honorarios vencidos históricos
  // (de antes de que existieran estos avisos) no tienen fila de notificación, y sin el
  // corte la primera corrida dispararía un burst por todo el backlog.
  const { data: vencidos, error } = await supabase
    .from('honorarios')
    .select(SELECT_AVISO)
    .eq('estado', 'vencido')
    .gte('fecha_vencimiento', addDays(today, -30))
    .lt('fecha_vencimiento', today);

  if (error) {
    console.error('[cron:honorarios-vencidos] Error buscando vencidos:', error.message);
    return;
  }

  let enviados = 0;
  let fallidos = 0;
  const contar = (resultado: string) => {
    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  };

  for (const honorario of (vencidos ?? []) as unknown as HonorarioAviso[]) {
    const emailCliente = honorario.cliente?.email;
    if (emailCliente) {
      contar(
        await entregarNotificacion({
          target: { honorario_id: honorario.id },
          user_id: honorario.cliente_id,
          tipo: 'vencido_cliente',
          enviar: () =>
            sendHonorarioVencidoCliente(emailCliente, {
              nombre: honorario.cliente?.nombre ?? '',
              descripcion: descripcionDe(honorario),
            }),
        }),
      );
    } else {
      console.error(`[cron:honorarios-vencidos] Honorario ${honorario.id} sin email de cliente; se omite el aviso.`);
    }

    contar(
      await entregarNotificacion({
        target: { honorario_id: honorario.id },
        user_id: honorario.cliente_id,
        tipo: 'vencido_cliente',
        canal: 'push',
        enviar: () =>
          sendPushToUser(honorario.cliente_id, {
            title: 'Vencieron tus honorarios',
            body: `${descripcionDe(honorario)} venció sin registrar el pago.`,
            url: '/cliente/honorarios',
          }),
      }),
    );
  }

  console.log(`[cron:honorarios-vencidos] Enviados ${enviados}, fallidos ${fallidos}, total ${vencidos?.length ?? 0}. END`);
}

// Avisa al CLIENTE (email + push) los honorarios pendientes del período en curso de
// cobro (el mes anterior, por mes vencido) y los SUELTOS (periodo NULL).
// Corre a diario: el dedup hace que cada aviso salga una sola vez, y las corridas
// siguientes reintentan gratis los 'pendiente'/'fallida' (p. ej. cliente que se
// suscribió a push después de la generación). También cubre los honorarios creados
// fuera del cron (alta de plan a mitad de mes).
export async function notificarHonorariosNuevos(): Promise<void> {
  const { anio, mes } = periodoAnteriorAR();
  const periodo = `${anio}-${String(mes).padStart(2, '0')}-01`;
  console.log(`[cron:honorarios-nuevos] START ${periodo}`);

  const { data: nuevos, error } = await supabase
    .from('honorarios')
    .select(SELECT_AVISO)
    .eq('estado', 'pendiente')
    .or(`periodo.eq.${periodo},periodo.is.null`);

  if (error) {
    console.error('[cron:honorarios-nuevos] Error buscando honorarios del período:', error.message);
    return;
  }

  let enviados = 0;
  let fallidos = 0;
  const contar = (resultado: string) => {
    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  };

  for (const honorario of (nuevos ?? []) as unknown as HonorarioAviso[]) {
    const emailCliente = honorario.cliente?.email;
    if (emailCliente) {
      contar(
        await entregarNotificacion({
          target: { honorario_id: honorario.id },
          user_id: honorario.cliente_id,
          tipo: 'nuevo',
          enviar: () =>
            sendNuevoHonorario(emailCliente, {
              nombre: honorario.cliente?.nombre ?? '',
              descripcion: descripcionDe(honorario),
              monto: honorario.monto,
              fecha_vencimiento: honorario.fecha_vencimiento,
            }),
        }),
      );
    } else {
      console.error(`[cron:honorarios-nuevos] Honorario ${honorario.id} sin email de cliente; se omite el aviso.`);
    }

    contar(
      await entregarNotificacion({
        target: { honorario_id: honorario.id },
        user_id: honorario.cliente_id,
        tipo: 'nuevo',
        canal: 'push',
        enviar: () =>
          sendPushToUser(honorario.cliente_id, {
            title: 'Nuevos honorarios',
            body: `${descripcionDe(honorario)} — vence el ${formatFechaCorta(honorario.fecha_vencimiento)}.`,
            url: '/cliente/honorarios',
          }),
      }),
    );
  }

  console.log(`[cron:honorarios-nuevos] Enviados ${enviados}, fallidos ${fallidos}, total ${nuevos?.length ?? 0}. END`);
}

// Recordatorio al CLIENTE (email + push): honorarios pendientes que vencen en 3 días.
export async function procesarHonorariosRecordatorios(): Promise<void> {
  const today = getDateAR();
  const targetDate = addDays(today, 3);
  console.log(`[cron:honorarios-recordatorios] START ${today} → vencen ${targetDate}`);

  const { data: proximos, error } = await supabase
    .from('honorarios')
    .select(SELECT_AVISO)
    .eq('estado', 'pendiente')
    .eq('fecha_vencimiento', targetDate);

  if (error) {
    console.error('[cron:honorarios-recordatorios] Error buscando próximos:', error.message);
    return;
  }

  let enviados = 0;
  let fallidos = 0;
  const contar = (resultado: string) => {
    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  };

  for (const honorario of (proximos ?? []) as unknown as HonorarioAviso[]) {
    const emailCliente = honorario.cliente?.email;
    if (emailCliente) {
      contar(
        await entregarNotificacion({
          target: { honorario_id: honorario.id },
          user_id: honorario.cliente_id,
          tipo: 'recordatorio_3dias',
          enviar: () =>
            sendRecordatorioHonorario(emailCliente, {
              nombre: honorario.cliente?.nombre ?? '',
              descripcion: descripcionDe(honorario),
              fecha_vencimiento: honorario.fecha_vencimiento,
            }),
        }),
      );
    } else {
      console.error(`[cron:honorarios-recordatorios] Honorario ${honorario.id} sin email de cliente; se omite el aviso.`);
    }

    contar(
      await entregarNotificacion({
        target: { honorario_id: honorario.id },
        user_id: honorario.cliente_id,
        tipo: 'recordatorio_3dias',
        canal: 'push',
        enviar: () =>
          sendPushToUser(honorario.cliente_id, {
            title: 'Recordatorio de honorarios',
            body: `${descripcionDe(honorario)} vence el ${formatFechaCorta(honorario.fecha_vencimiento)}.`,
            url: '/cliente/honorarios',
          }),
      }),
    );
  }

  console.log(`[cron:honorarios-recordatorios] Enviados ${enviados}, fallidos ${fallidos}, total ${proximos?.length ?? 0}. END`);
}

// Genera los honorarios del período ANTERIOR (mes vencido) para TODOS los estudios, a
// partir de los planes activos: el 1/7 se genera "junio", que vence en julio.
// Idempotente: re-correr el mismo mes no duplica.
export async function generarHonorariosMesVencido(): Promise<void> {
  const { anio, mes } = periodoAnteriorAR();
  console.log(`[cron:honorarios-generar] START periodo=${anio}-${mes} (mes vencido)`);

  const result = await generarHonorarios({ anio, mes, creado_por: null });
  if ('error' in result) {
    console.error('[cron:honorarios-generar] Error:', result.error);
    return;
  }

  console.log(`[cron:honorarios-generar] creados=${result.creados} ya_existentes=${result.ya_existentes} reactivados=${result.reactivados}. END`);

  // Aviso inmediato de los recién generados (el job diario los reintentaría igual).
  await notificarHonorariosNuevos();
}

export function initHonorariosJobs(): void {
  // Generación: día 1 de cada mes a las 08:00 ART (genera el período anterior).
  cron.schedule('0 8 1 * *', async () => {
    try {
      await generarHonorariosMesVencido();
    } catch (err) {
      console.error('[cron:honorarios-generar] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Diario 08:00 ART: vencidos + aviso de nuevos pendientes + recordatorios.
  cron.schedule('0 8 * * *', async () => {
    try {
      await procesarHonorariosVencidos();
    } catch (err) {
      console.error('[cron:honorarios-vencidos] Error inesperado:', err);
    }
    try {
      await notificarHonorariosNuevos();
    } catch (err) {
      console.error('[cron:honorarios-nuevos] Error inesperado:', err);
    }
    try {
      await procesarHonorariosRecordatorios();
    } catch (err) {
      console.error('[cron:honorarios-recordatorios] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('[cron] Jobs de honorarios inicializados — generar @ día 1 + vencidos/nuevos/recordatorios diario, 08:00 ART');
}
