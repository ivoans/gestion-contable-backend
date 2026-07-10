// tests/pushService.test.ts — canal push: flag, subs muertas (410), multi-device.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseMock, FromCall } from './helpers/supabaseMock';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));

const { sendNotification, setVapidDetails } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));
vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails },
}));

import { sendPushToUser } from '../src/services/pushService';

const ok = (data: unknown = null): FromCall['result'] => ({ data, error: null });

const sub = (id: string) => ({ id, endpoint: `https://push.example/${id}`, p256dh: 'p', auth: 'a' });
const payload = { title: 'Título', body: 'Cuerpo', url: '/cliente' };

// Error con statusCode como el que tira web-push (WebPushError).
const httpError = (statusCode: number) => Object.assign(new Error(`push ${statusCode}`), { statusCode });

beforeEach(() => {
  sb.reset();
  sendNotification.mockReset();
  setVapidDetails.mockReset();
  process.env.PUSH_ENABLED = 'true';
  process.env.VAPID_SUBJECT = 'mailto:test@test.com';
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
});

afterEach(() => {
  delete process.env.PUSH_ENABLED;
});

describe('pushService.sendPushToUser', () => {
  it("flag apagado → 'omitida' sin tocar la DB", async () => {
    process.env.PUSH_ENABLED = 'false';

    const resultado = await sendPushToUser('user1', payload);

    expect(resultado).toBe('omitida');
    expect(sb.calls).toHaveLength(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sin suscripciones → 'omitida' (la fila queda pendiente hasta que se suscriba)", async () => {
    sb.queue([{ table: 'push_subscriptions', result: ok([]) }]);

    const resultado = await sendPushToUser('user1', payload);

    expect(resultado).toBe('omitida');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('manda el payload JSON a todas las subs del user', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    sb.queue([{ table: 'push_subscriptions', result: ok([sub('s1'), sub('s2')]) }]);

    const resultado = await sendPushToUser('user1', payload);

    expect(resultado).toBe('enviada');
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example/s1', keys: { p256dh: 'p', auth: 'a' } },
      JSON.stringify(payload),
      expect.objectContaining({ TTL: 86400 }),
    );
  });

  it("410 → borra la sub muerta y sigue; con otra viva devuelve 'enviada'", async () => {
    sendNotification
      .mockRejectedValueOnce(httpError(410))
      .mockResolvedValueOnce({ statusCode: 201 });
    sb.queue([
      { table: 'push_subscriptions', result: ok([sub('muerta'), sub('viva')]) },
      { table: 'push_subscriptions', result: ok() }, // delete de la muerta
    ]);

    const resultado = await sendPushToUser('user1', payload);

    expect(resultado).toBe('enviada');
    const del = sb.calls.find((c) => c.op === 'delete');
    expect(del?.filters).toContainEqual(['eq', 'id', 'muerta']);
  });

  it("todas las subs muertas → las borra y devuelve 'omitida' (no es fallo)", async () => {
    sendNotification.mockRejectedValue(httpError(404));
    sb.queue([
      { table: 'push_subscriptions', result: ok([sub('s1'), sub('s2')]) },
      { table: 'push_subscriptions', result: ok() },
      { table: 'push_subscriptions', result: ok() },
    ]);

    const resultado = await sendPushToUser('user1', payload);

    expect(resultado).toBe('omitida');
    expect(sb.calls.filter((c) => c.op === 'delete')).toHaveLength(2);
  });

  it('todas fallan con error real → throw (la fila queda fallida y se reintenta)', async () => {
    sendNotification.mockRejectedValue(httpError(500));
    sb.queue([{ table: 'push_subscriptions', result: ok([sub('s1')]) }]);

    await expect(sendPushToUser('user1', payload)).rejects.toThrow('push 500');
  });

  it("una falla real + una enviada → 'enviada' (llegó al menos a un dispositivo)", async () => {
    sendNotification
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ statusCode: 201 });
    sb.queue([{ table: 'push_subscriptions', result: ok([sub('s1'), sub('s2')]) }]);

    const resultado = await sendPushToUser('user1', payload);

    expect(resultado).toBe('enviada');
  });
});
