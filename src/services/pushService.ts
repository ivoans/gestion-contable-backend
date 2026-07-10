import webpush from 'web-push';
import { supabase } from '../lib/supabase';
import type { ResultadoCanal } from './emailService';

/**
 * Canal push (Web Push / VAPID). Mismo contrato que emailService:
 *  - 'enviada': llegó a al menos una suscripción del usuario.
 *  - 'omitida': canal apagado (PUSH_ENABLED!=true) o el usuario no tiene suscripciones.
 *    El llamador deja la notificación 'pendiente' → se entrega cuando haya sub/canal.
 *  - throw: fallo real de envío (el llamador marca 'fallida' y reintenta).
 *
 * Las suscripciones muertas (404/410 del push service) se borran acá mismo: es la
 * única señal que da el protocolo de que el endpoint ya no existe.
 */

export type PushPayload = { title: string; body: string; url: string };

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string };

function pushEnabled(): boolean {
  return process.env.PUSH_ENABLED === 'true';
}

// Lazy: las claves VAPID pueden no estar en entornos con el canal apagado.
let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  configured = true;
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<ResultadoCanal> {
  if (!pushEnabled()) {
    console.log(`[push] SKIP (PUSH_ENABLED!=true) → ${userId} | ${payload.title}`);
    return 'omitida';
  }
  ensureConfigured();

  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (error) throw new Error(`No se pudieron leer push_subscriptions: ${error.message}`);

  const subs = (data ?? []) as SubRow[];
  if (subs.length === 0) return 'omitida';

  const body = JSON.stringify(payload);
  let exitos = 0;
  let ultimoError: unknown = null;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 86400 },
      );
      exitos++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Endpoint muerto (usuario revocó permiso / reinstaló la PWA): limpiar.
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        console.log(`[push] Sub muerta (${status}) borrada → ${userId}`);
      } else {
        ultimoError = err;
        console.error(`[push] FAIL → ${userId} | ${payload.title}`, err);
      }
    }
  }

  if (exitos > 0) {
    console.log(`[push] OK → ${userId} | ${payload.title} (${exitos}/${subs.length} subs)`);
    return 'enviada';
  }
  if (!ultimoError) return 'omitida'; // todas eran subs muertas, ya limpiadas
  throw ultimoError instanceof Error ? ultimoError : new Error(String(ultimoError));
}
