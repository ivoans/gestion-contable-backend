// tests/clientes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { SupabaseMock } from './helpers/supabaseMock';
import { makeUser } from './helpers/factories';
import { bearerFor } from './helpers/auth';

const { sb, bcryptMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return {
    sb: createSupabaseMock() as SupabaseMock,
    bcryptMock: { compare: vi.fn(), hash: vi.fn() },
  };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('bcryptjs', () => ({ default: bcryptMock }));

import { createApp } from '../src/app';

describe('clientes', () => {
  let app: ReturnType<typeof createApp>;

  const contadorA = makeUser({ id: 'contadorA', role: 'contador', estudio_id: 'estudio-A' });
  const contadorB = makeUser({ id: 'contadorB', role: 'contador', estudio_id: 'estudio-B' });
  const admin = makeUser({ id: 'adminX', role: 'admin' });
  const cliente = makeUser({ id: 'cliente-1', role: 'cliente', estudio_id: 'estudio-A' });

  const authA = bearerFor(contadorA);
  const authB = bearerFor(contadorB);
  const adminAuth = bearerFor(admin);
  const clienteAuth = bearerFor(cliente);

  beforeEach(() => {
    sb.reset();
    bcryptMock.hash.mockReset();
    bcryptMock.compare.mockReset();
    app = createApp();
  });

  describe('auth gate (requireRole contador)', () => {
    it('401 sin token', async () => {
      const res = await request(app).get('/api/clientes');
      expect(res.status).toBe(401);
    });

    it('403 si role=admin', async () => {
      const res = await request(app).get('/api/clientes').set('Authorization', adminAuth);
      expect(res.status).toBe(403);
    });

    it('403 si role=cliente', async () => {
      const res = await request(app).get('/api/clientes').set('Authorization', clienteAuth);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/clientes', () => {
    it('400 si falta nombre/email/password', async () => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({ nombre: 'X' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si password < 8', async () => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({ nombre: 'X', email: 'x@y.com', password: '1234567' });
      expect(res.status).toBe(400);
    });

    it.each([
      ['no-arroba'],
      ['@sinusuario.com'],
      ['espacios@dom .com'],
    ])('400 si email formato inválido: %s', async (badEmail) => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({ nombre: 'X', email: badEmail, password: '12345678' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Email inválido' });
      expect(sb.calls).toHaveLength(0);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('409 si email ya existe', async () => {
      sb.queue([{ table: 'users', result: { data: { id: 'otro' }, error: null } }]);
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678' });
      expect(res.status).toBe(409);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('201 + insert con estudio_id del JWT (no del body)', async () => {
      const created = makeUser({ role: 'cliente', estudio_id: 'estudio-A' });
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'users', result: { data: created, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed');

      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'Cliente Nuevo',
          email: 'cn@y.com',
          password: '12345678',
          cuit: '20-11111111-1',
          telefono: '+541112345678',
          // Intento de inyectar estudio_id ajeno: debe ignorarse.
          estudio_id: 'estudio-OTRO',
        });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);

      const insertCall = sb.calls[1];
      expect(insertCall.op).toBe('insert');
      expect(insertCall.payload).toMatchObject({
        nombre: 'Cliente Nuevo',
        email: 'cn@y.com',
        password_hash: 'hashed',
        cuit: '20-11111111-1',
        telefono: '+541112345678',
        role: 'cliente',
        estudio_id: 'estudio-A', // del JWT, no del body
        activo: true,
      });
      expect(insertCall.payload).not.toHaveProperty('password');
    });

    it('201 con cuit/telefono null si no enviados', async () => {
      const created = makeUser({ role: 'cliente', estudio_id: 'estudio-A' });
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'users', result: { data: created, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed');
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678' });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({ cuit: null, telefono: null });
    });
  });

  describe('GET /api/clientes (multi-tenant)', () => {
    it('200 lista filtrada por estudio_id del contador', async () => {
      sb.queue([{ table: 'users', result: { data: [cliente], error: null } }]);
      const res = await request(app).get('/api/clientes').set('Authorization', authA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([cliente]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });

    it('contador B no recibe clientes de estudio A', async () => {
      sb.queue([{ table: 'users', result: { data: [], error: null } }]);
      const res = await request(app).get('/api/clientes').set('Authorization', authB);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      // Filter scoped al estudio del JWT (B), no al de A.
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls[0].filters).not.toContainEqual(['eq', 'estudio_id', 'estudio-A']);
    });
  });

  describe('GET /api/clientes/:id', () => {
    it('404 si no existe', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/clientes/no-existe')
        .set('Authorization', authA);
      expect(res.status).toBe(404);
    });

    it('aislamiento: contador B pidiendo cliente de A → 404 (filtra por estudio_id)', async () => {
      // Mock devuelve null porque el query lleva estudio_id=B y el cliente real es de A.
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .get(`/api/clientes/${cliente.id}`)
        .set('Authorization', authB);
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('200 si pertenece al mismo estudio', async () => {
      sb.queue([{ table: 'users', result: { data: cliente, error: null } }]);
      const res = await request(app)
        .get(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(cliente);
    });
  });

  describe('PATCH /api/clientes/:id', () => {
    it('400 si ningún campo enviado', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('404 si cliente pertenece a otro estudio', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authB)
        .send({ nombre: 'Hack' });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
    });

    it('400 si email formato inválido en update (no llega a DB)', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ email: 'no-arroba' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Email inválido' });
      expect(sb.calls).toHaveLength(0);
    });

    it('409 si email ya tomado por otro user', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: { id: 'otro' }, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ email: 'tomado@x.com' });
      expect(res.status).toBe(409);
    });

    it('200 actualiza nombre + cuit + telefono', async () => {
      const updated = { ...cliente, nombre: 'Nuevo', cuit: '30-1', telefono: '+54' };
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ nombre: 'Nuevo', cuit: '30-1', telefono: '+54' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ nombre: 'Nuevo', cuit: '30-1', telefono: '+54' });
    });
  });

  describe('PATCH /api/clientes/:id/estado', () => {
    it('400 si activo no es boolean', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/estado`)
        .set('Authorization', authA)
        .send({ activo: 'true' });
      expect(res.status).toBe(400);
    });

    it('404 si cliente de otro estudio', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/estado`)
        .set('Authorization', authB)
        .send({ activo: false });
      expect(res.status).toBe(404);
    });

    it('200 toggle a inactivo', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: null, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/estado`)
        .set('Authorization', authA)
        .send({ activo: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Estado actualizado', activo: false });
      expect(sb.calls[1].payload).toEqual({ activo: false });
    });
  });

  describe('PATCH /api/clientes/:id/password', () => {
    it('401 sin token', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .send({ password: '12345678' });
      expect(res.status).toBe(401);
    });

    it('403 si role=admin', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .set('Authorization', adminAuth)
        .send({ password: '12345678' });
      expect(res.status).toBe(403);
    });

    it('403 si role=cliente', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .set('Authorization', clienteAuth)
        .send({ password: '12345678' });
      expect(res.status).toBe(403);
    });

    it('400 si falta password', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .set('Authorization', authA)
        .send({});
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('400 si password < 8', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .set('Authorization', authA)
        .send({ password: '1234567' });
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('404 si cliente pertenece a otro estudio', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .set('Authorization', authB)
        .send({ password: '12345678' });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-B']);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('404 si id corresponde a admin (filtro role=cliente)', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch(`/api/clientes/${admin.id}/password`)
        .set('Authorization', authA)
        .send({ password: '12345678' });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('404 si id corresponde a otro contador (filtro role=cliente)', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch(`/api/clientes/${contadorB.id}/password`)
        .set('Authorization', authA)
        .send({ password: '12345678' });
      expect(res.status).toBe(404);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'cliente']);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('204 en éxito + update con hash bcrypt (no plaintext)', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: null, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed-pw');

      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}/password`)
        .set('Authorization', authA)
        .send({ password: 'plaintext-secret' });

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(bcryptMock.hash).toHaveBeenCalledWith('plaintext-secret', 12);

      const updateCall = sb.calls[1];
      expect(updateCall.op).toBe('update');
      expect(updateCall.payload).toEqual({ password_hash: 'hashed-pw' });
      expect(updateCall.payload).not.toHaveProperty('password');
      expect(JSON.stringify(updateCall.payload)).not.toContain('plaintext-secret');
      expect(updateCall.filters).toContainEqual(['eq', 'id', cliente.id]);
    });
  });
});
