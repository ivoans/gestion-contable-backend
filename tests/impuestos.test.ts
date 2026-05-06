// tests/impuestos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser, makeImpuesto } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb, emailMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return {
    sb: createSupabaseMock() as SupabaseMock,
    emailMock: { sendNuevoImpuesto: vi.fn() },
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('../src/services/emailService', () => ({
  sendNuevoImpuesto: emailMock.sendNuevoImpuesto,
}));

import { createApp } from '../src/app';

describe('impuestos', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const contadorB = makeUser({ id: 'contadorB', role: 'contador', estudio_id: 'estudio-B' });
  const admin = makeUser({ role: 'admin' });
  const clienteA = makeUser({ id: 'cliente-A', role: 'cliente', estudio_id: 'estudio-A' });
  const clienteOtro = makeUser({ id: 'cliente-X', role: 'cliente', estudio_id: 'estudio-A' });

  const authA = bearerFor(contadorA);
  const authB = bearerFor(contadorB);
  const adminAuth = bearerFor(admin);
  const clienteAuth = bearerFor(clienteA);

  const validBody = {
    cliente_id: clienteA.id,
    tipo: 'IVA',
    monto: 1500,
    fecha_vencimiento: '2030-01-15',
    descripcion: 'Pago mensual',
    link_pago: 'https://pagar.example/abc',
  };

  beforeEach(() => {
    sb.reset();
    emailMock.sendNuevoImpuesto.mockReset();
    emailMock.sendNuevoImpuesto.mockResolvedValue(undefined);
    app = createApp();
  });

  describe('POST /api/impuestos', () => {
    it('401 sin token', async () => {
      const res = await request(app).post('/api/impuestos').send(validBody);
      expect(res.status).toBe(401);
    });

    it('403 si role=admin', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', adminAuth)
        .send(validBody);
      expect(res.status).toBe(403);
    });

    it('403 si role=cliente', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', clienteAuth)
        .send(validBody);
      expect(res.status).toBe(403);
    });

    it('400 si falta cliente_id/tipo/monto/fecha', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ tipo: 'IVA' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si tipo > 100 caracteres', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, tipo: 'x'.repeat(101) });
      expect(res.status).toBe(400);
    });

    it('400 si monto = 0', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, monto: 0 });
      expect(res.status).toBe(400);
    });

    it('400 si monto negativo', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, monto: -1 });
      expect(res.status).toBe(400);
    });

    it('400 si monto no es número', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, monto: '1500' });
      expect(res.status).toBe(400);
    });

    it('400 si fecha formato inválido', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, fecha_vencimiento: '15/01/2030' });
      expect(res.status).toBe(400);
    });

    it('400 si fecha es 2030-13-01 (mes inválido)', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, fecha_vencimiento: '2030-13-01' });
      expect(res.status).toBe(400);
    });

    it('400 si link_pago http://', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, link_pago: 'http://insecure.example/x' });
      expect(res.status).toBe(400);
    });

    it('400 si link_pago javascript:', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, link_pago: 'javascript:alert(1)' });
      expect(res.status).toBe(400);
    });

    it('404 si cliente_id pertenece a otro estudio', async () => {
      // contadorB busca cliente de estudio-A → query lleva eq estudio_id=B → null.
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authB)
        .send(validBody);
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(emailMock.sendNuevoImpuesto).not.toHaveBeenCalled();
    });

    it('201 + insert + email + notif (happy path)', async () => {
      const created = makeImpuesto({
        cliente_id: clienteA.id,
        estudio_id: 'estudio-A',
        tipo: validBody.tipo,
        monto: validBody.monto,
        fecha_vencimiento: validBody.fecha_vencimiento,
        link_pago: validBody.link_pago,
      });
      sb.queue([
        { table: 'users', result: { data: { id: clienteA.id }, error: null } },
        { table: 'impuestos', result: { data: created, error: null } },
        { table: 'users', result: { data: { email: clienteA.email, nombre: clienteA.nombre }, error: null } },
        { table: 'notificaciones', result: { data: null, error: null } },
      ]);

      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);

      // Insert impuesto: estudio_id del JWT, creado_por del JWT, estado pendiente.
      const insertCall = sb.calls[1];
      expect(insertCall.op).toBe('insert');
      expect(insertCall.payload).toMatchObject({
        estudio_id: 'estudio-A',
        cliente_id: clienteA.id,
        creado_por: contadorA.id,
        tipo: 'IVA',
        monto: 1500,
        fecha_vencimiento: '2030-01-15',
        estado: 'pendiente',
      });

      // Email mandado al cliente.
      expect(emailMock.sendNuevoImpuesto).toHaveBeenCalledOnce();
      expect(emailMock.sendNuevoImpuesto).toHaveBeenCalledWith(
        clienteA.email,
        expect.objectContaining({
          nombre: clienteA.nombre,
          tipo: 'IVA',
          monto: 1500,
          fecha_vencimiento: '2030-01-15',
        }),
      );

      // Notif registrada.
      const notifCall = sb.calls[3];
      expect(notifCall.op).toBe('insert');
      expect(notifCall.payload).toMatchObject({
        impuesto_id: created.id,
        user_id: clienteA.id,
        tipo: 'nuevo',
        canal: 'email',
      });
    });

    it('201 aunque email falle (no rompe el flujo)', async () => {
      const created = makeImpuesto({ cliente_id: clienteA.id, estudio_id: 'estudio-A' });
      sb.queue([
        { table: 'users', result: { data: { id: clienteA.id }, error: null } },
        { table: 'impuestos', result: { data: created, error: null } },
        { table: 'users', result: { data: { email: clienteA.email, nombre: clienteA.nombre }, error: null } },
        // notificaciones NO se llama porque el send falla antes.
      ]);
      emailMock.sendNuevoImpuesto.mockRejectedValueOnce(new Error('resend down'));

      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(sb.calls).toHaveLength(3); // sin notif insert
    });

    it('descripcion y link_pago null si no enviados', async () => {
      const created = makeImpuesto({ cliente_id: clienteA.id });
      sb.queue([
        { table: 'users', result: { data: { id: clienteA.id }, error: null } },
        { table: 'impuestos', result: { data: created, error: null } },
        { table: 'users', result: { data: { email: clienteA.email, nombre: clienteA.nombre }, error: null } },
        { table: 'notificaciones', result: { data: null, error: null } },
      ]);
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({
          cliente_id: clienteA.id,
          tipo: 'IVA',
          monto: 1500,
          fecha_vencimiento: '2030-01-15',
        });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({ descripcion: null, link_pago: null });
    });
  });

  describe('GET /api/impuestos', () => {
    it('200 lista filtrada por estudio_id', async () => {
      const lista = [makeImpuesto({ estudio_id: 'estudio-A' })];
      sb.queue([{ table: 'impuestos', result: { data: lista, error: null } }]);
      const res = await request(app).get('/api/impuestos').set('Authorization', authA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(lista);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });

    it('200 con filter cliente_id', async () => {
      sb.queue([{ table: 'impuestos', result: { data: [], error: null } }]);
      await request(app)
        .get('/api/impuestos')
        .query({ cliente_id: clienteA.id })
        .set('Authorization', authA);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', clienteA.id]);
    });

    it('200 con filter estado', async () => {
      sb.queue([{ table: 'impuestos', result: { data: [], error: null } }]);
      await request(app)
        .get('/api/impuestos')
        .query({ estado: 'vencido' })
        .set('Authorization', authA);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estado', 'vencido']);
    });

    it('400 si estado inválido', async () => {
      const res = await request(app)
        .get('/api/impuestos')
        .query({ estado: 'cancelado' })
        .set('Authorization', authA);
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });
  });

  describe('GET /api/impuestos/:id', () => {
    it('404 si cross-estudio', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/x-id')
        .set('Authorization', authB);
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('200 si pertenece al estudio', async () => {
      const imp = makeImpuesto({ estudio_id: 'estudio-A' });
      sb.queue([{ table: 'impuestos', result: { data: imp, error: null } }]);
      const res = await request(app)
        .get(`/api/impuestos/${imp.id}`)
        .set('Authorization', authA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(imp);
    });
  });

  describe('PATCH /api/impuestos/:id', () => {
    it('400 si monto negativo', async () => {
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authA)
        .send({ monto: -1 });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si fecha mal formato', async () => {
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authA)
        .send({ fecha_vencimiento: '01-2030-15' });
      expect(res.status).toBe(400);
    });

    it('400 si link_pago http://', async () => {
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authA)
        .send({ link_pago: 'http://x.com' });
      expect(res.status).toBe(400);
    });

    it('400 si ningún campo enviado', async () => {
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
    });

    it('404 si cross-estudio', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authB)
        .send({ tipo: 'Otro' });
      expect(res.status).toBe(404);
    });

    it('400 si impuesto pagado', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pagado' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authA)
        .send({ tipo: 'Otro' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pagado/);
    });

    it('200 actualiza tipo + monto', async () => {
      const updated = makeImpuesto({ tipo: 'Nuevo', monto: 2000 });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pendiente' }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/x')
        .set('Authorization', authA)
        .send({ tipo: 'Nuevo', monto: 2000 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ tipo: 'Nuevo', monto: 2000 });
    });
  });

  describe('PATCH /api/impuestos/:id/estado', () => {
    it('404 si no existe / cross-estudio', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/impuestos/x/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(404);
    });

    it('400 si ya pagado', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pagado' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/x/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pagado/);
    });

    it('200 transiciona pendiente → pagado con pagado_at + pagado_por', async () => {
      const updated = makeImpuesto({ estado: 'pagado' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pendiente' }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/x/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);

      const updateCall = sb.calls[1];
      expect(updateCall.op).toBe('update');
      expect(updateCall.payload).toMatchObject({
        estado: 'pagado',
        pagado_por: contadorA.id,
      });
      expect(typeof updateCall.payload.pagado_at).toBe('string');
    });

    it('mandar { estado: "vencido" } en body igual setea pagado (body ignorado)', async () => {
      const updated = makeImpuesto({ estado: 'pagado' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pendiente' }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/x/estado')
        .set('Authorization', authA)
        .send({ estado: 'vencido' });
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload.estado).toBe('pagado');
    });

    it('200 vencido → pagado (transición permitida)', async () => {
      const updated = makeImpuesto({ estado: 'pagado' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'vencido' }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/x/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/impuestos/mis-impuestos', () => {
    it('401 sin token', async () => {
      const res = await request(app).get('/api/impuestos/mis-impuestos');
      expect(res.status).toBe(401);
    });

    it('403 si role=contador', async () => {
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos')
        .set('Authorization', authA);
      expect(res.status).toBe(403);
    });

    it('200 cliente solo ve los suyos, agrupados', async () => {
      const lista = [
        makeImpuesto({ id: 'i1', cliente_id: clienteA.id, estado: 'pendiente' }),
        makeImpuesto({ id: 'i2', cliente_id: clienteA.id, estado: 'vencido' }),
        makeImpuesto({ id: 'i3', cliente_id: clienteA.id, estado: 'pagado' }),
        makeImpuesto({ id: 'i4', cliente_id: clienteA.id, estado: 'pendiente' }),
      ];
      sb.queue([{ table: 'impuestos', result: { data: lista, error: null } }]);

      const res = await request(app)
        .get('/api/impuestos/mis-impuestos')
        .set('Authorization', clienteAuth);

      expect(res.status).toBe(200);
      expect(res.body.pendientes).toHaveLength(2);
      expect(res.body.vencidos).toHaveLength(1);
      expect(res.body.pagados).toHaveLength(1);
      // Filter scoped al cliente_id del JWT.
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', clienteA.id]);
    });

    it('cliente con eq cliente_id de su id (aislamiento)', async () => {
      sb.queue([{ table: 'impuestos', result: { data: [], error: null } }]);
      const otroAuth = bearerFor(clienteOtro);
      await request(app)
        .get('/api/impuestos/mis-impuestos')
        .set('Authorization', otroAuth);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', clienteOtro.id]);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'cliente_id', clienteA.id]);
    });
  });

  describe('GET /api/impuestos/mis-impuestos/:id', () => {
    it('403 si role=contador', async () => {
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos/x')
        .set('Authorization', authA);
      expect(res.status).toBe(403);
    });

    it('404 si impuesto no es del cliente', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos/de-otro')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', clienteA.id]);
    });

    it('200 si es del cliente', async () => {
      const imp = makeImpuesto({ cliente_id: clienteA.id });
      sb.queue([{ table: 'impuestos', result: { data: imp, error: null } }]);
      const res = await request(app)
        .get(`/api/impuestos/mis-impuestos/${imp.id}`)
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(imp);
    });
  });
});
