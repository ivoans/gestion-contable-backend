// tests/admin.test.ts
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

describe('admin', () => {
  let app: ReturnType<typeof createApp>;
  const admin = makeUser({ id: 'admin-1', role: 'admin' });
  const contador = makeUser({ id: 'contador-1', role: 'contador', estudio_id: 'estudio-1' });
  const cliente = makeUser({ id: 'cliente-1', role: 'cliente', estudio_id: 'estudio-1' });
  const adminAuth = bearerFor(admin);
  const contadorAuth = bearerFor(contador);
  const clienteAuth = bearerFor(cliente);

  beforeEach(() => {
    sb.reset();
    bcryptMock.compare.mockReset();
    bcryptMock.hash.mockReset();
    app = createApp();
  });

  describe('auth gate', () => {
    it('401 sin token', async () => {
      const res = await request(app).get('/api/admin/contadores');
      expect(res.status).toBe(401);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=contador', async () => {
      const res = await request(app)
        .get('/api/admin/contadores')
        .set('Authorization', contadorAuth);
      expect(res.status).toBe(403);
      expect(sb.calls).toHaveLength(0);
    });

    it('403 si role=cliente', async () => {
      const res = await request(app)
        .get('/api/admin/contadores')
        .set('Authorization', clienteAuth);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/admin/contadores', () => {
    it('400 si faltan campos', async () => {
      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: 'x@y.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requeridos/);
      expect(sb.calls).toHaveLength(0);
    });

    it.each([
      ['no-arroba'],
      ['@sinusuario.com'],
      ['espacios@dom .com'],
    ])('400 si email formato inválido: %s', async (badEmail) => {
      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: badEmail, password: '12345678', estudio_id: 'e1' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Email inválido' });
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si password < 8', async () => {
      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: 'x@y.com', password: '1234567', estudio_id: 'e1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/8 caracteres/);
      expect(sb.calls).toHaveLength(0);
    });

    it('409 si email ya existe', async () => {
      sb.queue([{ table: 'users', result: { data: { id: 'existing' }, error: null } }]);
      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678', estudio_id: 'e1' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Email ya registrado');
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('400 si estudio no existe', async () => {
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'estudios', result: { data: null, error: null } },
      ]);
      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678', estudio_id: 'e1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Estudio/);
    });

    it('400 si estudio inactivo', async () => {
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'estudios', result: { data: { id: 'e1', activo: false }, error: null } },
      ]);
      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678', estudio_id: 'e1' });
      expect(res.status).toBe(400);
    });

    it('201 + user creado, password hasheada con cost=12', async () => {
      const created = makeUser({ role: 'contador', estudio_id: 'e1', email: 'x@y.com' });
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'estudios', result: { data: { id: 'e1', activo: true }, error: null } },
        { table: 'users', result: { data: created, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed-pw');

      const res = await request(app)
        .post('/api/admin/contadores')
        .set('Authorization', adminAuth)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678', estudio_id: 'e1' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(bcryptMock.hash).toHaveBeenCalledWith('12345678', 12);
      // Insert con role contador + activo true + password hasheada (no plaintext).
      const insertCall = sb.calls[2];
      expect(insertCall.op).toBe('insert');
      expect(insertCall.payload).toMatchObject({
        nombre: 'X',
        email: 'x@y.com',
        password_hash: 'hashed-pw',
        estudio_id: 'e1',
        role: 'contador',
        activo: true,
      });
      expect(insertCall.payload).not.toHaveProperty('password');
    });
  });

  describe('GET /api/admin/contadores', () => {
    it('200 lista contadores', async () => {
      sb.queue([{ table: 'users', result: { data: [contador], error: null } }]);
      const res = await request(app)
        .get('/api/admin/contadores')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([contador]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'contador']);
    });

    it('500 si DB error', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: { message: 'boom' } } }]);
      const res = await request(app)
        .get('/api/admin/contadores')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/admin/contadores/:id', () => {
    it('404 si no existe', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .get('/api/admin/contadores/no-existe')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(404);
    });

    it('200 con contador', async () => {
      sb.queue([{ table: 'users', result: { data: contador, error: null } }]);
      const res = await request(app)
        .get(`/api/admin/contadores/${contador.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(contador);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'id', contador.id]);
      expect(sb.calls[0].filters).toContainEqual(['eq', 'role', 'contador']);
    });
  });

  describe('PATCH /api/admin/contadores/:id', () => {
    it('404 si contador no existe', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/admin/contadores/no-existe')
        .set('Authorization', adminAuth)
        .send({ nombre: 'Nuevo' });
      expect(res.status).toBe(404);
    });

    it('400 si ningún campo enviado', async () => {
      sb.queue([{ table: 'users', result: { data: { id: contador.id }, error: null } }]);
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No se enviaron campos/);
    });

    it('400 si email formato inválido en update (no llega a DB)', async () => {
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}`)
        .set('Authorization', adminAuth)
        .send({ email: '@sinusuario.com' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Email inválido' });
      expect(sb.calls).toHaveLength(0);
    });

    it('409 si email ya tomado por otro user', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: contador.id }, error: null } },
        { table: 'users', result: { data: { id: 'otro' }, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}`)
        .set('Authorization', adminAuth)
        .send({ email: 'tomado@x.com' });
      expect(res.status).toBe(409);
      // El check de email-conflict excluye al propio user (.neq('id', id)).
      const conflictCall = sb.calls[1];
      expect(conflictCall.filters).toContainEqual(['eq', 'email', 'tomado@x.com']);
      expect(conflictCall.filters).toContainEqual(['neq', 'id', contador.id]);
    });

    it('200 actualiza nombre y email', async () => {
      const updated = { ...contador, nombre: 'Nuevo', email: 'nuevo@x.com' };
      sb.queue([
        { table: 'users', result: { data: { id: contador.id }, error: null } },
        { table: 'users', result: { data: null, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}`)
        .set('Authorization', adminAuth)
        .send({ nombre: 'Nuevo', email: 'nuevo@x.com' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[2].op).toBe('update');
      expect(sb.calls[2].payload).toEqual({ nombre: 'Nuevo', email: 'nuevo@x.com' });
    });

    it('200 actualiza solo nombre (sin email-conflict check)', async () => {
      const updated = { ...contador, nombre: 'Solo' };
      sb.queue([
        { table: 'users', result: { data: { id: contador.id }, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}`)
        .set('Authorization', adminAuth)
        .send({ nombre: 'Solo' });
      expect(res.status).toBe(200);
      expect(sb.calls).toHaveLength(2);
      expect(sb.calls[1].payload).toEqual({ nombre: 'Solo' });
    });
  });

  describe('PATCH /api/admin/contadores/:id/estado', () => {
    it('400 si activo no enviado', async () => {
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}/estado`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si activo no es boolean', async () => {
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}/estado`)
        .set('Authorization', adminAuth)
        .send({ activo: 'true' });
      expect(res.status).toBe(400);
    });

    it('404 si contador no existe', async () => {
      sb.queue([{ table: 'users', result: { data: null, error: null } }]);
      const res = await request(app)
        .patch('/api/admin/contadores/no-existe/estado')
        .set('Authorization', adminAuth)
        .send({ activo: false });
      expect(res.status).toBe(404);
    });

    it('200 toggle a inactivo', async () => {
      sb.queue([
        { table: 'users', result: { data: { id: contador.id }, error: null } },
        { table: 'users', result: { data: null, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/admin/contadores/${contador.id}/estado`)
        .set('Authorization', adminAuth)
        .send({ activo: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Estado actualizado', activo: false });
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({ activo: false });
    });
  });
});
