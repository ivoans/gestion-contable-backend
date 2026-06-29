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
// authenticate hace lookup de activo en DB (S1); acá se mockea siempre-activo
// para no interferir con la cola del supabaseMock de cada test.
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));
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

    it('descripcion null si no enviada', async () => {
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
      expect(sb.calls[1].payload).toMatchObject({ descripcion: null, vep: null });
    });

    it('400 si vep > 100 caracteres', async () => {
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, vep: 'x'.repeat(101) });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('201 persiste vep (trimeado) si se envía', async () => {
      const created = makeImpuesto({ cliente_id: clienteA.id, estudio_id: 'estudio-A', vep: '1234567890' });
      sb.queue([
        { table: 'users', result: { data: { id: clienteA.id }, error: null } },
        { table: 'impuestos', result: { data: created, error: null } },
        { table: 'users', result: { data: { email: clienteA.email, nombre: clienteA.nombre }, error: null } },
        { table: 'notificaciones', result: { data: null, error: null } },
      ]);
      const res = await request(app)
        .post('/api/impuestos')
        .set('Authorization', authA)
        .send({ ...validBody, vep: '  1234567890  ' });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({ vep: '1234567890' });
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
        .get('/api/impuestos/00000000-0000-4000-8000-000000000000')
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
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ monto: -1 });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si fecha mal formato', async () => {
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ fecha_vencimiento: '01-2030-15' });
      expect(res.status).toBe(400);
    });

    it('400 si ningún campo enviado', async () => {
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
    });

    it('404 si cross-estudio', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authB)
        .send({ tipo: 'Otro' });
      expect(res.status).toBe(404);
    });

    it('400 si impuesto pagado', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pagado' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
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
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ tipo: 'Nuevo', monto: 2000 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ tipo: 'Nuevo', monto: 2000 });
    });

    it('completa borrador con monto + vep → transiciona a pendiente, persiste monto y vep', async () => {
      const updated = makeImpuesto({ estado: 'pendiente', monto: 2000, vep: '1234567890' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'borrador', monto: null }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ monto: 2000, vep: ' 1234567890 ' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ monto: 2000, vep: '1234567890', estado: 'pendiente' });
    });

    it('borrador solo con vep (sin monto) → sigue borrador, monto no se setea', async () => {
      const updated = makeImpuesto({ estado: 'borrador', monto: null, vep: 'VEP-9' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'borrador', monto: null }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ vep: 'VEP-9' });
      expect(res.status).toBe(200);
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ vep: 'VEP-9' });
      expect(sb.calls[1].payload.estado).toBeUndefined();
      expect(sb.calls[1].payload).not.toHaveProperty('monto');
    });

    it('400 si monto = 0 sobre un borrador (no transiciona)', async () => {
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ monto: 0, vep: 'V1' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('pendiente editando monto/vep sigue pendiente (sin re-transición)', async () => {
      const updated = makeImpuesto({ estado: 'pendiente', monto: 3000, vep: 'V2' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pendiente', monto: 1000 }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', authA)
        .send({ monto: 3000, vep: 'V2' });
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload).toEqual({ monto: 3000, vep: 'V2' });
      expect(sb.calls[1].payload.estado).toBeUndefined();
    });
  });

  describe('PATCH /api/impuestos/:id/estado', () => {
    it('404 si no existe / cross-estudio', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(404);
    });

    it('400 si ya pagado', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pagado' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pagado/);
    });

    it('400 si es borrador (guard antes de la DB, no 500)', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'borrador' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/borrador/);
      // No hizo el update: solo la query de lectura.
      expect(sb.calls).toHaveLength(1);
    });

    it('200 transiciona pendiente → pagado con pagado_at + pagado_por', async () => {
      const updated = makeImpuesto({ estado: 'pagado' });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pendiente' }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/estado')
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
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/estado')
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
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /api/impuestos/mis-impuestos/:id/estado (cliente paga)', () => {
    it('401 sin token', async () => {
      const res = await request(app).patch('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/estado').send({});
      expect(res.status).toBe(401);
    });

    it('403 si role=contador', async () => {
      const res = await request(app)
        .patch('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(403);
    });

    it('404 si no existe / no es del cliente', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(404);
    });

    it('404 si es borrador (el cliente no lo ve)', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'borrador' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(404);
      // Guard antes de la DB: solo la lectura, sin update.
      expect(sb.calls).toHaveLength(1);
    });

    it('400 si ya pagado', async () => {
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pagado' }, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pagado/);
    });

    it('200 pendiente → pagado con pagado_por = cliente', async () => {
      const updated = makeImpuesto({ estado: 'pagado', cliente_id: clienteA.id });
      sb.queue([
        { table: 'impuestos', result: { data: { id: 'x', estado: 'pendiente' }, error: null } },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000/estado')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);

      const updateCall = sb.calls[1];
      expect(updateCall.op).toBe('update');
      expect(updateCall.payload).toMatchObject({ estado: 'pagado', pagado_por: clienteA.id });
      expect(typeof updateCall.payload.pagado_at).toBe('string');
    });
  });

  describe('PATCH /api/impuestos/:id/revertir (contador revierte)', () => {
    it('403 si role=cliente', async () => {
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/revertir')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(403);
    });

    it('404 si no existe / cross-estudio', async () => {
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/revertir')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(404);
    });

    it('400 si no está pagado', async () => {
      sb.queue([
        {
          table: 'impuestos',
          result: { data: { id: 'x', estado: 'pendiente', fecha_vencimiento: '2030-01-15' }, error: null },
        },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/revertir')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/revertir/i);
      expect(sb.calls).toHaveLength(1);
    });

    it('200 pagado → vencido si ya venció, limpia pagado_at/por', async () => {
      const updated = makeImpuesto({ estado: 'vencido' });
      sb.queue([
        {
          table: 'impuestos',
          result: { data: { id: 'x', estado: 'pagado', fecha_vencimiento: '2000-01-01' }, error: null },
        },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/revertir')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload).toMatchObject({
        estado: 'vencido',
        pagado_at: null,
        pagado_por: null,
      });
    });

    it('200 pagado → pendiente si aún no venció', async () => {
      const updated = makeImpuesto({ estado: 'pendiente' });
      sb.queue([
        {
          table: 'impuestos',
          result: { data: { id: 'x', estado: 'pagado', fecha_vencimiento: '2100-01-01' }, error: null },
        },
        { table: 'impuestos', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch('/api/impuestos/00000000-0000-4000-8000-000000000000/revertir')
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload.estado).toBe('pendiente');
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

    it('no devuelve borradores: query filtra neq estado borrador', async () => {
      sb.queue([{ table: 'impuestos', result: { data: [], error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(200);
      expect(sb.calls[0].filters).toContainEqual(['neq', 'estado', 'borrador']);
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

    it('FIX 3: query filtra por estudio_id del JWT además de cliente_id', async () => {
      sb.queue([{ table: 'impuestos', result: { data: [], error: null } }]);
      await request(app)
        .get('/api/impuestos/mis-impuestos')
        .set('Authorization', clienteAuth);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', clienteA.id]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', clienteA.estudio_id]);
    });

    it('FIX 3: si DB devuelve [] (estudio no matchea), respuesta agrupada vacía', async () => {
      // Simula: existen impuestos con cliente_id correcto pero estudio_id distinto al JWT.
      // El filter estudio_id del query los excluye → DB devuelve [].
      sb.queue([{ table: 'impuestos', result: { data: [], error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pendientes: [], vencidos: [], pagados: [] });
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
        .get('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000')
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

    it('FIX 3: 404 si impuesto pertenece a otro estudio (filter por estudio_id del JWT)', async () => {
      // DB devuelve null porque el filtro estudio_id NO matchea aunque cliente_id e id sí.
      sb.queue([{ table: 'impuestos', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/impuestos/mis-impuestos/00000000-0000-4000-8000-000000000000')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'id', '00000000-0000-4000-8000-000000000000']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'cliente_id', clienteA.id]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', clienteA.estudio_id]);
    });
  });

  describe('POST /api/impuestos/generar', () => {
    // CUITs válidos (módulo 11). El último dígito = dígito verificador.
    const CUIT_MONO = '27112223334'; // termina en 4
    const CUIT_RI = '20123456786'; // termina en 6

    it('401 sin token', async () => {
      const res = await request(app).post('/api/impuestos/generar').send({});
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=admin', async () => {
      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', clienteAuth)
        .send({});
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si anio fuera de rango', async () => {
      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2023, mes: 6 });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si mes inválido', async () => {
      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 13 });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('genera monotributista: monotributo + ing brutos, ambos con terminacion null', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [{ id: 'cli-mono', nombre: 'Mono SA', cuit: CUIT_MONO, condicion_fiscal: 'monotributista' }],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              { obligacion: 'monotributo', terminacion_cuit: null, fecha_vencimiento: '2026-06-20' },
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
            ],
            error: null,
          },
        },
        { table: 'impuestos', result: { data: [{ id: 'imp1' }, { id: 'imp2' }], error: null } },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        anio: 2026,
        mes: 6,
        creados: 2,
        ya_existentes: 0,
        clientes_salteados: [],
        obligaciones_sin_fecha: [],
      });

      // Clientes: solo activos del estudio del JWT.
      expect(sb.calls[0].table).toBe('users');
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'activo', true]);

      // Calendario: del estudio, mismo anio/mes.
      expect(sb.calls[1].table).toBe('vencimientos');
      expect(sb.calls[1].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'anio', 2026]);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'mes', 6]);

      // Upsert idempotente con las dos obligaciones del monotributista.
      const upsert = sb.calls[2];
      expect(upsert.op).toBe('upsert');
      expect(upsert.onConflict).toBe('cliente_id, obligacion, periodo');
      expect(upsert.ignoreDuplicates).toBe(true);
      expect(upsert.payload).toHaveLength(2);
      expect(upsert.payload).toContainEqual(
        expect.objectContaining({
          estudio_id: 'estudio-A',
          cliente_id: 'cli-mono',
          creado_por: contadorA.id,
          obligacion: 'monotributo',
          tipo: 'Monotributo',
          periodo: '2026-06-01',
          fecha_vencimiento: '2026-06-20',
          estado: 'borrador',
          monto: null,
          vep: null,
        }),
      );
      expect(upsert.payload).toContainEqual(
        expect.objectContaining({
          cliente_id: 'cli-mono',
          obligacion: 'ingresos_brutos',
          tipo: 'Ingresos Brutos',
          fecha_vencimiento: '2026-06-22',
          estado: 'borrador',
        }),
      );

      expect(emailMock.sendNuevoImpuesto).not.toHaveBeenCalled();
    });

    it('genera RI: iva + autonomos por dígito de CUIT, ing brutos con null', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [{ id: 'cli-ri', nombre: 'RI SA', cuit: CUIT_RI, condicion_fiscal: 'responsable_inscripto' }],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              // El CUIT termina en 6: la fila correcta para iva/autonomos es terminacion 6.
              { obligacion: 'iva', terminacion_cuit: 6, fecha_vencimiento: '2026-06-18' },
              { obligacion: 'iva', terminacion_cuit: 5, fecha_vencimiento: '2026-06-17' }, // distractor
              { obligacion: 'autonomos', terminacion_cuit: 6, fecha_vencimiento: '2026-06-12' },
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
            ],
            error: null,
          },
        },
        { table: 'impuestos', result: { data: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }], error: null } },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body.creados).toBe(3);
      expect(res.body.obligaciones_sin_fecha).toEqual([]);

      const payload = sb.calls[2].payload as Array<Record<string, unknown>>;
      expect(payload).toHaveLength(3);

      // IVA tomó la fila de terminacion 6, NO la distractora de terminacion 5.
      const iva = payload.find((p) => p.obligacion === 'iva');
      expect(iva).toMatchObject({ tipo: 'IVA', fecha_vencimiento: '2026-06-18' });

      const autonomos = payload.find((p) => p.obligacion === 'autonomos');
      expect(autonomos).toMatchObject({ tipo: 'Autónomos', fecha_vencimiento: '2026-06-12' });

      const ingBrutos = payload.find((p) => p.obligacion === 'ingresos_brutos');
      expect(ingBrutos).toMatchObject({ tipo: 'Ingresos Brutos', fecha_vencimiento: '2026-06-22' });

      expect(emailMock.sendNuevoImpuesto).not.toHaveBeenCalled();
    });

    it('genera opcionales del RI: CM y SICOSS por dígito, casas particulares con null', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [
              {
                id: 'cli-ri',
                nombre: 'RI Full',
                cuit: CUIT_RI, // termina en 6
                condicion_fiscal: 'responsable_inscripto',
                convenio_multilateral: true,
                empleadores_sicoss: true,
                casas_particulares: true,
              },
            ],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              { obligacion: 'iva', terminacion_cuit: 6, fecha_vencimiento: '2026-06-18' },
              { obligacion: 'autonomos', terminacion_cuit: 6, fecha_vencimiento: '2026-06-12' },
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
              { obligacion: 'convenio_multilateral', terminacion_cuit: 6, fecha_vencimiento: '2026-06-16' },
              { obligacion: 'empleadores_sicoss', terminacion_cuit: 6, fecha_vencimiento: '2026-06-11' },
              { obligacion: 'casas_particulares', terminacion_cuit: null, fecha_vencimiento: '2026-06-10' },
            ],
            error: null,
          },
        },
        {
          table: 'impuestos',
          result: {
            data: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }, { id: 'i4' }, { id: 'i5' }, { id: 'i6' }],
            error: null,
          },
        },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body.creados).toBe(6);
      expect(res.body.obligaciones_sin_fecha).toEqual([]);

      const payload = sb.calls[2].payload as Array<Record<string, unknown>>;
      expect(payload).toHaveLength(6);

      const cm = payload.find((p) => p.obligacion === 'convenio_multilateral');
      expect(cm).toMatchObject({ tipo: 'Convenio Multilateral', fecha_vencimiento: '2026-06-16' });

      const sicoss = payload.find((p) => p.obligacion === 'empleadores_sicoss');
      expect(sicoss).toMatchObject({ tipo: 'Empleadores SICOSS', fecha_vencimiento: '2026-06-11' });

      const casas = payload.find((p) => p.obligacion === 'casas_particulares');
      expect(casas).toMatchObject({ tipo: 'Casas Particulares', fecha_vencimiento: '2026-06-10' });
    });

    it('genera CM para monotributista con el flag; sin flags no genera opcionales', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [
              {
                id: 'cli-mono-cm',
                nombre: 'Mono CM',
                cuit: CUIT_MONO, // termina en 4
                condicion_fiscal: 'monotributista',
                convenio_multilateral: true,
                empleadores_sicoss: false,
                casas_particulares: false,
              },
              {
                id: 'cli-mono-plain',
                nombre: 'Mono Plain',
                cuit: CUIT_MONO,
                condicion_fiscal: 'monotributista',
                convenio_multilateral: false,
                empleadores_sicoss: false,
                casas_particulares: false,
              },
            ],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              { obligacion: 'monotributo', terminacion_cuit: null, fecha_vencimiento: '2026-06-20' },
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
              { obligacion: 'convenio_multilateral', terminacion_cuit: 4, fecha_vencimiento: '2026-06-15' },
            ],
            error: null,
          },
        },
        {
          table: 'impuestos',
          result: { data: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }, { id: 'i4' }, { id: 'i5' }], error: null },
        },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);

      const payload = sb.calls[2].payload as Array<Record<string, unknown>>;
      // Mono CM: monotributo + ing brutos + CM. Mono Plain: solo los dos base.
      expect(payload).toHaveLength(5);

      const cmRows = payload.filter((p) => p.obligacion === 'convenio_multilateral');
      expect(cmRows).toHaveLength(1);
      expect(cmRows[0]).toMatchObject({
        cliente_id: 'cli-mono-cm',
        tipo: 'Convenio Multilateral',
        fecha_vencimiento: '2026-06-15', // fila de terminación 4 (último dígito del CUIT)
      });
    });

    it('saltea cliente sin condicion_fiscal y con cuit inválido', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [
              { id: 'cli-noc', nombre: 'Sin Cond', cuit: CUIT_RI, condicion_fiscal: null },
              { id: 'cli-badc', nombre: 'Cuit Malo', cuit: '123', condicion_fiscal: 'monotributista' },
            ],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              { obligacion: 'monotributo', terminacion_cuit: null, fecha_vencimiento: '2026-06-20' },
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
            ],
            error: null,
          },
        },
        // Sin candidatos → no hay upsert a impuestos (no se programa).
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body.creados).toBe(0);
      expect(res.body.ya_existentes).toBe(0);
      expect(res.body.clientes_salteados).toContainEqual({
        cliente_id: 'cli-noc',
        nombre: 'Sin Cond',
        motivo: 'Sin condición fiscal',
      });
      expect(res.body.clientes_salteados).toContainEqual({
        cliente_id: 'cli-badc',
        nombre: 'Cuit Malo',
        motivo: 'CUIT inválido',
      });
      // No tocó impuestos: solo users + vencimientos.
      expect(sb.calls).toHaveLength(2);
      expect(emailMock.sendNuevoImpuesto).not.toHaveBeenCalled();
    });

    it('saltea obligación sin fila en el calendario → obligaciones_sin_fecha', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [{ id: 'cli-ri2', nombre: 'RI2', cuit: CUIT_RI, condicion_fiscal: 'responsable_inscripto' }],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              { obligacion: 'iva', terminacion_cuit: 6, fecha_vencimiento: '2026-06-18' },
              // autonomos ausente → debe caer en obligaciones_sin_fecha
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
            ],
            error: null,
          },
        },
        { table: 'impuestos', result: { data: [{ id: 'i1' }, { id: 'i2' }], error: null } },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body.creados).toBe(2);
      expect(res.body.obligaciones_sin_fecha).toEqual([
        { cliente_id: 'cli-ri2', nombre: 'RI2', obligacion: 'autonomos' },
      ]);
      expect(sb.calls[2].payload).toHaveLength(2);
    });

    it('idempotencia: segunda corrida crea 0 y reporta ya_existentes', async () => {
      sb.queue([
        {
          table: 'users',
          result: {
            data: [{ id: 'cli-mono', nombre: 'Mono', cuit: CUIT_MONO, condicion_fiscal: 'monotributista' }],
            error: null,
          },
        },
        {
          table: 'vencimientos',
          result: {
            data: [
              { obligacion: 'monotributo', terminacion_cuit: null, fecha_vencimiento: '2026-06-20' },
              { obligacion: 'ingresos_brutos', terminacion_cuit: null, fecha_vencimiento: '2026-06-22' },
            ],
            error: null,
          },
        },
        // ON CONFLICT DO NOTHING: ya existían las dos → select() devuelve vacío.
        { table: 'impuestos', result: { data: [], error: null } },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body.creados).toBe(0);
      expect(res.body.ya_existentes).toBe(2);
      expect(sb.calls[2].ignoreDuplicates).toBe(true);
      expect(sb.calls[2].onConflict).toBe('cliente_id, obligacion, periodo');
    });

    it('multi-tenant: contador B solo consulta su estudio', async () => {
      sb.queue([
        { table: 'users', result: { data: [], error: null } },
        { table: 'vencimientos', result: { data: [], error: null } },
      ]);

      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authB)
        .send({ anio: 2026, mes: 6 });

      expect(res.status).toBe(200);
      expect(res.body.creados).toBe(0);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'estudio_id', 'estudio-A']);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls[1].filters).not.toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });

    it('sin body → usa anio/mes actual', async () => {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth() + 1;
      sb.queue([
        { table: 'users', result: { data: [], error: null } },
        { table: 'vencimientos', result: { data: [], error: null } },
      ]);

      const res = await request(app).post('/api/impuestos/generar').set('Authorization', authA);

      expect(res.status).toBe(200);
      expect(res.body.anio).toBe(y);
      expect(res.body.mes).toBe(m);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'anio', y]);
      expect(sb.calls[1].filters).toContainEqual(['eq', 'mes', m]);
    });

    it('500 si la DB de clientes da error', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: { message: 'boom' } } }]);
      const res = await request(app)
        .post('/api/impuestos/generar')
        .set('Authorization', authA)
        .send({ anio: 2026, mes: 6 });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Error interno del servidor' });
    });
  });
});
