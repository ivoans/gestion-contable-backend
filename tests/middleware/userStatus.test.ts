// tests/middleware/userStatus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('../helpers/supabaseMock');
  return { sb: createSupabaseMock() };
});

vi.mock('../../src/lib/supabase', () => ({ supabase: sb.client }));

import { getEstadoActivo } from '../../src/middleware/userStatus';

const USER_ID = 'b6f8a4e2-0000-4000-8000-000000000001';

describe('middleware/getEstadoActivo', () => {
  beforeEach(() => {
    sb.reset();
  });

  it('ok con usuario activo y estudio activo', async () => {
    sb.queue([{
      table: 'users',
      result: { data: { activo: true, estudio: { activo: true } }, error: null },
    }]);
    expect(await getEstadoActivo(USER_ID)).toEqual({ ok: true });
    expect(sb.calls[0].filters).toContainEqual(['eq', 'id', USER_ID]);
    expect(sb.calls[0].terminal).toBe('maybeSingle');
  });

  it('ok con admin sin estudio (estudio null)', async () => {
    sb.queue([{
      table: 'users',
      result: { data: { activo: true, estudio: null }, error: null },
    }]);
    expect(await getEstadoActivo(USER_ID)).toEqual({ ok: true });
  });

  it('usuario_inactivo si activo=false', async () => {
    sb.queue([{
      table: 'users',
      result: { data: { activo: false, estudio: { activo: true } }, error: null },
    }]);
    expect(await getEstadoActivo(USER_ID)).toEqual({ ok: false, reason: 'usuario_inactivo' });
  });

  it('usuario_inactivo si el usuario no existe', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: null } }]);
    expect(await getEstadoActivo(USER_ID)).toEqual({ ok: false, reason: 'usuario_inactivo' });
  });

  it('estudio_inactivo si el estudio está desactivado', async () => {
    sb.queue([{
      table: 'users',
      result: { data: { activo: true, estudio: { activo: false } }, error: null },
    }]);
    expect(await getEstadoActivo(USER_ID)).toEqual({ ok: false, reason: 'estudio_inactivo' });
  });

  it('error_db si PostgREST devuelve error', async () => {
    sb.queue([{ table: 'users', result: { data: null, error: { message: 'boom' } } }]);
    expect(await getEstadoActivo(USER_ID)).toEqual({ ok: false, reason: 'error_db' });
  });
});
