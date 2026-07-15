import cron from 'node-cron';
import { supabase } from '../lib/supabase';
import {
  sendVencido,
  sendVencidoCliente,
  sendRecordatorio,
  sendGeneracionDigest,
} from '../services/emailService';
import { sendPushToUser } from '../services/pushService';
import { entregarNotificacion } from '../services/notificacionesService';
import {
  getDateAR,
  addDays,
  formatFechaCorta,
  primerDiaMesAR,
  formatPeriodoLargo,
} from '../utils/fechas';

type ImpuestoVencido = {
  id: string;
  cliente_id: string;
  creado_por: string;
  tipo: string;
  cliente: { nombre: string; email: string } | null;
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
    .select('id, cliente_id, creado_por, tipo, cliente:users!cliente_id(nombre, email), contador:users!creado_por(email)')
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

  const contar = (resultado: string) => {
    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  };

  for (const impuesto of vencidos as unknown as ImpuestoVencido[]) {
    // Aviso al CONTADOR (creado_por, B2) — texto de gestión.
    const emailContador = impuesto.contador?.email;
    if (emailContador) {
      contar(
        await entregarNotificacion({
          target: { impuesto_id: impuesto.id },
          user_id: impuesto.creado_por,
          tipo: 'vencido',
          enviar: () =>
            sendVencido(emailContador, {
              nombre_cliente: impuesto.cliente?.nombre ?? '',
              tipo: impuesto.tipo,
            }),
        }),
      );
    } else {
      console.error(`[cron:vencidos] Impuesto ${impuesto.id} sin email de contador (creado_por=${impuesto.creado_por}); se omite el aviso al contador.`);
    }

    // Copia al CLIENTE — aviso independiente (tipo 'vencido_cliente') con texto propio.
    // Tipo distinto = fila de dedup separada, no pisa la del contador.
    const emailCliente = impuesto.cliente?.email;
    if (emailCliente) {
      contar(
        await entregarNotificacion({
          target: { impuesto_id: impuesto.id },
          user_id: impuesto.cliente_id,
          tipo: 'vencido_cliente',
          enviar: () =>
            sendVencidoCliente(emailCliente, {
              nombre: impuesto.cliente?.nombre ?? '',
              tipo: impuesto.tipo,
            }),
        }),
      );
    } else {
      console.error(`[cron:vencidos] Impuesto ${impuesto.id} sin email de cliente (cliente_id=${impuesto.cliente_id}); se omite el aviso al cliente.`);
    }

    // Mismo aviso al cliente por push (canal aditivo, fila de dedup propia).
    contar(
      await entregarNotificacion({
        target: { impuesto_id: impuesto.id },
        user_id: impuesto.cliente_id,
        tipo: 'vencido_cliente',
        canal: 'push',
        enviar: () =>
          sendPushToUser(impuesto.cliente_id, {
            title: 'Venció tu impuesto',
            body: `${impuesto.tipo} venció sin registrar el pago.`,
            url: '/cliente',
          }),
      }),
    );
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

  const contar = (resultado: string) => {
    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  };

  // El recordatorio va al CLIENTE (le avisamos que su impuesto vence en 3 días). La capa
  // de entrega saltea los ya 'enviada' y reintenta 'pendiente'/'fallida'.
  for (const impuesto of proximos as unknown as ImpuestoRecordatorio[]) {
    contar(
      await entregarNotificacion({
        target: { impuesto_id: impuesto.id },
        user_id: impuesto.cliente_id,
        tipo: 'recordatorio_3dias',
        enviar: () =>
          sendRecordatorio(impuesto.cliente.email, {
            nombre: impuesto.cliente.nombre,
            tipo: impuesto.tipo,
            fecha_vencimiento: impuesto.fecha_vencimiento,
          }),
      }),
    );

    contar(
      await entregarNotificacion({
        target: { impuesto_id: impuesto.id },
        user_id: impuesto.cliente_id,
        tipo: 'recordatorio_3dias',
        canal: 'push',
        enviar: () =>
          sendPushToUser(impuesto.cliente_id, {
            title: 'Recordatorio de vencimiento',
            body: `${impuesto.tipo} vence el ${formatFechaCorta(impuesto.fecha_vencimiento)}.`,
            url: '/cliente',
          }),
      }),
    );
  }

  console.log(`[cron:recordatorios] Enviados ${enviados}, fallidos ${fallidos}, total ${proximos.length}. END ${new Date().toISOString()}`);
}

type ImpuestoBorradorDigest = {
  id: string;
  cliente_id: string;
  tipo: string;
  cliente: { nombre: string; email: string } | null;
};

// Aviso DIGEST al CLIENTE cuando se le generan sus obligaciones del período: UN solo
// email + push por cliente listando todo lo generado, en vez de N avisos de una (pedido
// de la contadora: avisar al generar; el monto de cada impuesto llega después con el
// aviso 'nuevo' de borrador → pendiente).
//
// La tabla notificaciones exige un target impuesto/honorario, así que el digest se ancla
// al borrador MÁS ANTIGUO del cliente en el período (orden created_at, id): esa fila no
// cambia cuando se agregan obligaciones después, y el dedup (target, tipo, canal) da un
// solo digest por (cliente, período). Corre tras la generación (aviso inmediato) y a
// diario (reintento gratis de 'pendiente'/'fallida' por el dedup).
export async function notificarGeneracionDigest(periodo?: string): Promise<void> {
  const periodoDigest = periodo ?? primerDiaMesAR();
  console.log(`[cron:generacion-digest] START ${periodoDigest}`);

  const { data, error } = await supabase
    .from('impuestos')
    .select('id, cliente_id, tipo, cliente:users!cliente_id(nombre, email)')
    .eq('estado', 'borrador')
    .eq('periodo', periodoDigest)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    console.error('[cron:generacion-digest] Error buscando borradores:', error.message);
    return;
  }

  const filas = (data ?? []) as unknown as ImpuestoBorradorDigest[];
  if (filas.length === 0) {
    console.log('[cron:generacion-digest] Sin borradores del período. END');
    return;
  }

  // Agrupar por cliente preservando el orden: la primera fila del grupo es el ancla.
  const porCliente = new Map<string, ImpuestoBorradorDigest[]>();
  for (const fila of filas) {
    const grupo = porCliente.get(fila.cliente_id);
    if (grupo) grupo.push(fila);
    else porCliente.set(fila.cliente_id, [fila]);
  }

  let enviados = 0;
  let fallidos = 0;
  const contar = (resultado: string) => {
    if (resultado === 'enviada') enviados++;
    else if (resultado === 'fallida') fallidos++;
  };

  const periodoLabel = formatPeriodoLargo(periodoDigest);

  for (const [cliente_id, grupo] of porCliente) {
    const ancla = grupo[0];
    const tipos = grupo.map((g) => g.tipo);

    const emailCliente = ancla.cliente?.email;
    if (emailCliente) {
      contar(
        await entregarNotificacion({
          target: { impuesto_id: ancla.id },
          user_id: cliente_id,
          tipo: 'generacion_digest',
          enviar: () =>
            sendGeneracionDigest(emailCliente, {
              nombre: ancla.cliente?.nombre ?? '',
              periodo: periodoLabel,
              tipos,
            }),
        }),
      );
    } else {
      console.error(`[cron:generacion-digest] Cliente ${cliente_id} sin email; se omite el digest por email.`);
    }

    contar(
      await entregarNotificacion({
        target: { impuesto_id: ancla.id },
        user_id: cliente_id,
        tipo: 'generacion_digest',
        canal: 'push',
        enviar: () =>
          sendPushToUser(cliente_id, {
            title: `Se generaron tus obligaciones de ${periodoLabel}`,
            body: `${tipos.join(', ')}. Tu contadora va a confirmar los montos.`,
            url: '/cliente',
          }),
      }),
    );
  }

  console.log(`[cron:generacion-digest] Enviados ${enviados}, fallidos ${fallidos}, clientes ${porCliente.size}. END`);
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

  // Reintento del digest de generación (el aviso inmediato sale al generar; esto
  // barre los 'pendiente'/'fallida', p. ej. canal apagado o Resend caído).
  cron.schedule('0 8 * * *', async () => {
    try {
      await notificarGeneracionDigest();
    } catch (err) {
      console.error('[cron:generacion-digest] Error inesperado:', err);
    }
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log('[cron] Jobs inicializados — vencidos + recordatorios + generacion-digest @ 08:00 ART');
}
