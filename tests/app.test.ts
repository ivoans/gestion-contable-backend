// tests/app.test.ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/middleware/rateLimits', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createApp } from '../src/app';

describe('createApp — trust proxy (FIX 1)', () => {
  it('app.get("trust proxy") devuelve valor truthy', () => {
    const app = createApp();
    // Con app.set('trust proxy', 1) el getter retorna el valor (number) o función derivada.
    // Lo esencial: no es false/undefined.
    expect(app.get('trust proxy')).toBeTruthy();
  });

  it('req.ip respeta X-Forwarded-For cuando trust proxy está activo', async () => {
    // Probe endpoint: armo una app sólo para introspección de req.ip.
    // Confirmamos que createApp produce un app con la misma propiedad heredada del setting.
    const app = createApp();
    // Express expone trust proxy también vía función `proxyaddr.compile`.
    // En lugar de inspeccionar internals, verifico el comportamiento con un endpoint propio.
    const probe = express();
    probe.set('trust proxy', app.get('trust proxy'));
    probe.get('/probe-ip', (req, res) => {
      res.json({ ip: req.ip });
    });

    const res = await request(probe)
      .get('/probe-ip')
      .set('X-Forwarded-For', '203.0.113.42');

    expect(res.status).toBe(200);
    // Con trust proxy activo + 1 hop, req.ip toma el último valor del header.
    expect(res.body.ip).toBe('203.0.113.42');
  });
});
