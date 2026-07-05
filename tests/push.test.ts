// tests/push.test.ts — rutas de suscripción Web Push (/api/push).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));

import { createApp } from '../src/app';

describe('push', () => {
  let app: ReturnType<typeof createApp>;

  const cliente = makeUser({ id: 'cliente-1', role: 'cliente', estudio_id: 'estudio-A' });
  const contador = makeUser({ id: 'contador-1', role: 'contador', estudio_id: 'estudio-A' });
  const clienteAuth = bearerFor(cliente);
  const contadorAuth = bearerFor(contador);

  const validSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'clave-p256dh', auth: 'clave-auth' },
  };

  beforeEach(() => {
    sb.reset();
    app = createApp();
  });

  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
  });

  describe('GET /api/push/vapid-public-key', () => {
    it('401 sin token', async () => {
      const res = await request(app).get('/api/push/vapid-public-key');
      expect(res.status).toBe(401);
    });

    it('200 con la clave pública', async () => {
      process.env.VAPID_PUBLIC_KEY = 'clave-publica';
      const res = await request(app).get('/api/push/vapid-public-key').set('Authorization', clienteAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ publicKey: 'clave-publica' });
    });

    it('503 si push no está configurado', async () => {
      const res = await request(app).get('/api/push/vapid-public-key').set('Authorization', clienteAuth);
      expect(res.status).toBe(503);
    });
  });

  describe('POST /api/push/subscriptions', () => {
    it('401 sin token', async () => {
      const res = await request(app).post('/api/push/subscriptions').send(validSub);
      expect(res.status).toBe(401);
    });

    it('400 si falta endpoint o keys', async () => {
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('Authorization', clienteAuth)
        .send({ endpoint: validSub.endpoint });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si endpoint no es https', async () => {
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('Authorization', clienteAuth)
        .send({ ...validSub, endpoint: 'http://inseguro.com/x' });
      expect(res.status).toBe(400);
    });

    it('400 si endpoint gigante (>2048)', async () => {
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('Authorization', clienteAuth)
        .send({ ...validSub, endpoint: `https://x.com/${'a'.repeat(2100)}` });
      expect(res.status).toBe(400);
    });

    it('201 upsertea por endpoint con el user del token', async () => {
      sb.queue([{ table: 'push_subscriptions', result: { data: null, error: null } }]);

      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('Authorization', clienteAuth)
        .send(validSub);

      expect(res.status).toBe(201);
      const call = sb.calls[0];
      expect(call.op).toBe('upsert');
      expect(call.onConflict).toBe('endpoint');
      expect(call.payload).toEqual({
        user_id: cliente.id,
        endpoint: validSub.endpoint,
        p256dh: 'clave-p256dh',
        auth: 'clave-auth',
      });
    });

    it('cualquier rol autenticado puede suscribirse (gating en el emisor)', async () => {
      sb.queue([{ table: 'push_subscriptions', result: { data: null, error: null } }]);
      const res = await request(app)
        .post('/api/push/subscriptions')
        .set('Authorization', contadorAuth)
        .send(validSub);
      expect(res.status).toBe(201);
      expect(sb.calls[0].payload).toMatchObject({ user_id: contador.id });
    });
  });

  describe('DELETE /api/push/subscriptions', () => {
    it('401 sin token', async () => {
      const res = await request(app).delete('/api/push/subscriptions').send({ endpoint: validSub.endpoint });
      expect(res.status).toBe(401);
    });

    it('400 sin endpoint', async () => {
      const res = await request(app)
        .delete('/api/push/subscriptions')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('204 borra solo la sub propia (filtra endpoint + user_id)', async () => {
      sb.queue([{ table: 'push_subscriptions', result: { data: null, error: null } }]);

      const res = await request(app)
        .delete('/api/push/subscriptions')
        .set('Authorization', clienteAuth)
        .send({ endpoint: validSub.endpoint });

      expect(res.status).toBe(204);
      const call = sb.calls[0];
      expect(call.op).toBe('delete');
      expect(call.filters).toContainEqual(['eq', 'endpoint', validSub.endpoint]);
      expect(call.filters).toContainEqual(['eq', 'user_id', cliente.id]);
    });
  });
});
