import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';

// Clave pública VAPID para que el front arme la suscripción (PushManager.subscribe).
// La privada nunca sale del backend.
export async function getVapidPublicKey(_req: Request, res: Response): Promise<void> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    res.status(503).json({ error: 'Push no configurado' });
    return;
  }
  res.json({ publicKey });
}

type SubscriptionBody = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

function parseSubscription(body: SubscriptionBody): { endpoint: string; p256dh: string; auth: string } | null {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;

  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!endpoint.startsWith('https://') || endpoint.length > 2048) return null;
  if (p256dh.length === 0 || auth.length === 0) return null;

  return { endpoint, p256dh, auth };
}

// Upsert por endpoint: cubre la re-suscripción del mismo navegador y el caso de otro
// user logueado en él (el endpoint pasa a pertenecer al user actual).
export async function guardarSuscripcion(req: Request, res: Response): Promise<void> {
  const sub = parseSubscription(req.body as SubscriptionBody);
  if (!sub) {
    res.status(400).json({ error: 'Suscripción inválida: se espera { endpoint, keys: { p256dh, auth } }' });
    return;
  }

  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { user_id: req.user!.id, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        { onConflict: 'endpoint' },
      );

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function borrarSuscripcion(req: Request, res: Response): Promise<void> {
  const endpoint = (req.body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    res.status(400).json({ error: 'Falta endpoint' });
    return;
  }

  try {
    // Solo borra suscripciones propias.
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', req.user!.id);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
