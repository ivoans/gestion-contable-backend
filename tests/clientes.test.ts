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
// authenticate hace lookup de activo en DB (S1); acá se mockea siempre-activo
// para no interferir con la cola del supabaseMock de cada test.
vi.mock('../src/middleware/userStatus', () => ({
  getEstadoActivo: vi.fn(async () => ({ ok: true })),
}));
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

  // CUIT 20-11111111-2: dígito verificador correcto (módulo 11). El proyecto lo
  // normaliza a 11 dígitos al persistir.
  const CUIT_VALIDO = '20-11111111-2';
  const CUIT_VALIDO_NORM = '20111111112';

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

    it('400 si falta condicion_fiscal', async () => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({ nombre: 'X', email: 'x@y.com', password: '12345678', cuit: CUIT_VALIDO });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'condicion_fiscal inválida' });
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si condicion_fiscal inválida', async () => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'X',
          email: 'x@y.com',
          password: '12345678',
          cuit: CUIT_VALIDO,
          condicion_fiscal: 'otra_cosa',
        });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'condicion_fiscal inválida' });
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si falta cuit', async () => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'X',
          email: 'x@y.com',
          password: '12345678',
          condicion_fiscal: 'monotributista',
        });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'CUIT inválido' });
      expect(sb.calls).toHaveLength(0);
    });

    it.each([
      ['largo inválido', '20-1111111-2'],
      ['dígito verificador inválido', '20-11111111-1'],
    ])('400 si cuit inválido: %s', async (_caso, badCuit) => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'X',
          email: 'x@y.com',
          password: '12345678',
          condicion_fiscal: 'monotributista',
          cuit: badCuit,
        });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'CUIT inválido' });
      expect(sb.calls).toHaveLength(0);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('409 si email ya existe', async () => {
      sb.queue([{ table: 'users', result: { data: { id: 'otro' }, error: null } }]);
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'X',
          email: 'x@y.com',
          password: '12345678',
          condicion_fiscal: 'monotributista',
          cuit: CUIT_VALIDO,
        });
      expect(res.status).toBe(409);
      expect(bcryptMock.hash).not.toHaveBeenCalled();
    });

    it('201 persiste condicion_fiscal + categoria + cuit normalizado, estudio_id del JWT (no del body)', async () => {
      const created = makeUser({
        role: 'cliente',
        estudio_id: 'estudio-A',
        condicion_fiscal: 'responsable_inscripto',
        categoria: 'A',
        cuit: CUIT_VALIDO_NORM,
      });
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
          cuit: CUIT_VALIDO,
          condicion_fiscal: 'responsable_inscripto',
          categoria: 'A',
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
        cuit: CUIT_VALIDO_NORM, // normalizado a 11 dígitos
        condicion_fiscal: 'responsable_inscripto',
        categoria: 'A',
        telefono: '+541112345678',
        role: 'cliente',
        estudio_id: 'estudio-A', // del JWT, no del body
        activo: true,
      });
      expect(insertCall.payload).not.toHaveProperty('password');
    });

    it('400 si flag opcional no booleano', async () => {
      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'X',
          email: 'x@y.com',
          password: '12345678',
          condicion_fiscal: 'monotributista',
          cuit: CUIT_VALIDO,
          convenio_multilateral: 'si',
        });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'convenio_multilateral debe ser boolean' });
      expect(sb.calls).toHaveLength(0);
    });

    it('201 monotributista con sicoss/casas=true (aplican a ambas condiciones desde 2026-07)', async () => {
      const created = makeUser({
        role: 'cliente',
        estudio_id: 'estudio-A',
        condicion_fiscal: 'monotributista',
        cuit: CUIT_VALIDO_NORM,
        empleadores_sicoss: true,
        casas_particulares: true,
      });
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'users', result: { data: created, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed');

      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'Mono SICOSS',
          email: 'mono-sicoss@y.com',
          password: '12345678',
          cuit: CUIT_VALIDO,
          condicion_fiscal: 'monotributista',
          empleadores_sicoss: true,
          casas_particulares: true,
        });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({
        empleadores_sicoss: true,
        casas_particulares: true,
      });
    });

    it('201 persiste flags de impuestos opcionales (RI con los tres)', async () => {
      const created = makeUser({
        role: 'cliente',
        estudio_id: 'estudio-A',
        condicion_fiscal: 'responsable_inscripto',
        cuit: CUIT_VALIDO_NORM,
        convenio_multilateral: true,
        empleadores_sicoss: true,
        casas_particulares: true,
      });
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'users', result: { data: created, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed');

      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'RI Full',
          email: 'ri@y.com',
          password: '12345678',
          cuit: CUIT_VALIDO,
          condicion_fiscal: 'responsable_inscripto',
          convenio_multilateral: true,
          empleadores_sicoss: true,
          casas_particulares: true,
        });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({
        convenio_multilateral: true,
        empleadores_sicoss: true,
        casas_particulares: true,
      });
    });

    it('201 monotributista con convenio_multilateral=true (CM aplica a ambas condiciones)', async () => {
      const created = makeUser({
        role: 'cliente',
        estudio_id: 'estudio-A',
        condicion_fiscal: 'monotributista',
        cuit: CUIT_VALIDO_NORM,
        convenio_multilateral: true,
      });
      sb.queue([
        { table: 'users', result: { data: null, error: null } },
        { table: 'users', result: { data: created, error: null } },
      ]);
      bcryptMock.hash.mockResolvedValue('hashed');

      const res = await request(app)
        .post('/api/clientes')
        .set('Authorization', authA)
        .send({
          nombre: 'Mono CM',
          email: 'mono@y.com',
          password: '12345678',
          cuit: CUIT_VALIDO,
          condicion_fiscal: 'monotributista',
          convenio_multilateral: true,
        });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({
        convenio_multilateral: true,
        empleadores_sicoss: false,
        casas_particulares: false,
      });
    });

    it('201 con categoria/telefono null si no enviados', async () => {
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
          nombre: 'X',
          email: 'x@y.com',
          password: '12345678',
          condicion_fiscal: 'monotributista',
          cuit: CUIT_VALIDO,
        });
      expect(res.status).toBe(201);
      expect(sb.calls[1].payload).toMatchObject({ categoria: null, telefono: null });
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
        .get('/api/clientes/00000000-0000-4000-8000-000000000000')
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

    it('200 actualiza nombre + cuit (normalizado) + telefono', async () => {
      const updated = { ...cliente, nombre: 'Nuevo', cuit: CUIT_VALIDO_NORM, telefono: '+54' };
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ nombre: 'Nuevo', cuit: CUIT_VALIDO, telefono: '+54' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[1].op).toBe('update');
      expect(sb.calls[1].payload).toEqual({
        nombre: 'Nuevo',
        cuit: CUIT_VALIDO_NORM,
        telefono: '+54',
      });
    });

    it('200 edita condicion_fiscal + categoria', async () => {
      const updated = { ...cliente, condicion_fiscal: 'responsable_inscripto', categoria: 'B' };
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ condicion_fiscal: 'responsable_inscripto', categoria: 'B' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(sb.calls[1].payload).toEqual({
        condicion_fiscal: 'responsable_inscripto',
        categoria: 'B',
      });
    });

    it('400 si condicion_fiscal inválida al editar (no llega a DB)', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ condicion_fiscal: 'otra_cosa' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'condicion_fiscal inválida' });
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si cuit inválido al editar (no llega a DB)', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ cuit: '20-11111111-1' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'CUIT inválido' });
      expect(sb.calls).toHaveLength(0);
    });

    it('400 si flag opcional no booleano al editar (no llega a DB)', async () => {
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ empleadores_sicoss: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'empleadores_sicoss debe ser boolean' });
      expect(sb.calls).toHaveLength(0);
    });

    it('200 monotributista puede marcar casas_particulares (aplica a ambas condiciones desde 2026-07)', async () => {
      const updated = { ...cliente, condicion_fiscal: 'monotributista', casas_particulares: true };
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ casas_particulares: true });
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload).toEqual({ casas_particulares: true });
    });

    it('200 al pasar a monotributista los flags sicoss/casas se conservan (ya no se limpian)', async () => {
      const updated = { ...cliente, condicion_fiscal: 'monotributista' };
      sb.queue([
        { table: 'users', result: { data: { id: cliente.id }, error: null } },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ condicion_fiscal: 'monotributista' });
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload).toEqual({ condicion_fiscal: 'monotributista' });
    });

    it('200 actualiza flags opcionales en RI', async () => {
      const updated = { ...cliente, convenio_multilateral: true, empleadores_sicoss: true };
      sb.queue([
        {
          table: 'users',
          result: {
            data: {
              id: cliente.id,
              condicion_fiscal: 'responsable_inscripto',
              empleadores_sicoss: false,
              casas_particulares: false,
            },
            error: null,
          },
        },
        { table: 'users', result: { data: updated, error: null } },
      ]);
      const res = await request(app)
        .patch(`/api/clientes/${cliente.id}`)
        .set('Authorization', authA)
        .send({ convenio_multilateral: true, empleadores_sicoss: true });
      expect(res.status).toBe(200);
      expect(sb.calls[1].payload).toEqual({
        convenio_multilateral: true,
        empleadores_sicoss: true,
      });
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
