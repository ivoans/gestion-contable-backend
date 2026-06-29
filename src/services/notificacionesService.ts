import { supabase } from '../lib/supabase';
import type { ResultadoCanal } from './emailService';

/**
 * Capa de entrega de notificaciones — desacopla "hay que avisar" del "se mandó".
 *
 * Por qué existe (B3 de AUDIT.md): antes el cron marcaba el impuesto 'vencido' y en el
 * mismo paso mandaba el email; si el envío fallaba, el aviso se perdía para siempre
 * (la próxima corrida ya no lo agarraba). Y con el canal apagado igual se insertaba la
 * fila "enviada", así que al prenderlo nunca se mandaba.
 *
 * Ahora cada aviso es una fila en `notificaciones` con `estado_envio`:
 *   - 'pendiente': hay que mandarla (recién creada o canal estaba apagado).
 *   - 'enviada':   ya se entregó (dedup: no se reintenta).
 *   - 'fallida':   el envío tiró error; se reintenta en la próxima corrida.
 *
 * El cron re-evalúa los candidatos en cada corrida y llama acá; las 'enviada' se saltean,
 * las 'pendiente'/'fallida' se reintentan. Channel-agnostic: el callback `enviar` puede
 * ser email hoy o push mañana (se cablea en F3 sin tocar esta lógica).
 */

export type Target = { impuesto_id: string } | { honorario_id: string };

export type ResultadoEntrega = 'enviada' | 'omitida' | 'fallida' | 'ya_enviada';

function targetCol(target: Target): { col: 'impuesto_id' | 'honorario_id'; val: string } {
  if ('impuesto_id' in target) return { col: 'impuesto_id', val: target.impuesto_id };
  return { col: 'honorario_id', val: target.honorario_id };
}

/**
 * Garantiza una fila de notificación para (target, tipo) e intenta entregarla.
 * Idempotente y reintentable: si ya está 'enviada' no hace nada; si no existe la crea
 * 'pendiente'; ante un envío exitoso la marca 'enviada', omitido la deja 'pendiente',
 * y con error la marca 'fallida' (para reintentar).
 */
export async function entregarNotificacion(params: {
  target: Target;
  /** Destinatario (a quién apunta el aviso). Para 'vencido' es el contador (creado_por). */
  user_id: string;
  tipo: 'nuevo' | 'recordatorio_3dias' | 'vencido' | 'vencido_cliente';
  canal?: string;
  enviar: () => Promise<ResultadoCanal>;
}): Promise<ResultadoEntrega> {
  const { target, user_id, tipo, canal = 'email', enviar } = params;
  const { col, val } = targetCol(target);

  // Dedup: ¿ya hay una fila para este (target, tipo)?
  const { data: existente, error: findErr } = await supabase
    .from('notificaciones')
    .select('id, estado_envio, intentos')
    .eq(col, val)
    .eq('tipo', tipo)
    .maybeSingle();

  if (findErr) throw new Error(`No se pudo leer notificaciones: ${findErr.message}`);

  const actual = existente as { id: string; estado_envio: string; intentos: number } | null;
  if (actual && actual.estado_envio === 'enviada') return 'ya_enviada';

  // Asegurar la fila (pendiente). Si no existe, crearla preservando el conteo de intentos.
  let rowId = actual?.id;
  let intentos = actual?.intentos ?? 0;
  if (!rowId) {
    const { data: nueva, error: insErr } = await supabase
      .from('notificaciones')
      .insert({ [col]: val, user_id, tipo, canal, estado_envio: 'pendiente' })
      .select('id')
      .single();

    if (insErr || !nueva) {
      // Posible carrera con otra corrida que la insertó primero (unique parcial). Releer.
      const { data: again } = await supabase
        .from('notificaciones')
        .select('id, estado_envio, intentos')
        .eq(col, val)
        .eq('tipo', tipo)
        .maybeSingle();
      const reread = again as { id: string; estado_envio: string; intentos: number } | null;
      if (reread?.estado_envio === 'enviada') return 'ya_enviada';
      if (!reread) throw new Error(`No se pudo crear la notificación: ${insErr?.message ?? 'desconocido'}`);
      rowId = reread.id;
      intentos = reread.intentos ?? intentos;
    } else {
      rowId = (nueva as { id: string }).id;
    }
  }

  // Intentar entregar por el canal.
  try {
    const resultado = await enviar();
    if (resultado === 'omitida') {
      // Canal apagado: dejar 'pendiente', NO marcar enviada (B3 sec.).
      return 'omitida';
    }
    await supabase
      .from('notificaciones')
      .update({
        estado_envio: 'enviada',
        enviada_at: new Date().toISOString(),
        intentos: intentos + 1,
        ultimo_error: null,
      })
      .eq('id', rowId);
    return 'enviada';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('notificaciones')
      .update({ estado_envio: 'fallida', intentos: intentos + 1, ultimo_error: msg })
      .eq('id', rowId);
    return 'fallida';
  }
}
