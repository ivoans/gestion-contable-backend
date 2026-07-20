// tests/honorariosCron.test.ts — avisos de honorarios al cliente (F3): vencidos,
// nuevos del período y recordatorio 3 días, por email + push vía entregarNotificacion.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseMock, FromCall } from './helpers/supabaseMock';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));

const { sendNuevoHonorario, sendRecordatorioHonorario, sendHonorarioVencidoCliente, sendPushToUser } = vi.hoisted(() => ({
  sendNuevoHonorario: vi.fn(),
  sendRecordatorioHonorario: vi.fn(),
  sendHonorarioVencidoCliente: vi.fn(),
  sendPushToUser: vi.fn(),
}));
vi.mock('../src/services/emailService', () => ({
  sendNuevoHonorario,
  sendRecordatorioHonorario,
  sendHonorarioVencidoCliente,
}));
vi.mock('../src/services/pushService', () => ({ sendPushToUser }));

import {
  procesarHonorariosVencidos,
  notificarHonorariosNuevos,
  procesarHonorariosRecordatorios,
} from '../src/jobs/honorariosCron';

const ok = (data: unknown = null): FromCall['result'] => ({ data, error: null });

const transicion = (): FromCall => ({ table: 'honorarios', result: ok() });
const selectHonorarios = (rows: unknown[]): FromCall => ({ table: 'honorarios', result: ok(rows) });
const notifLookup = (row: unknown): FromCall => ({ table: 'notificaciones', result: ok(row) });
const notifInsert = (id = 'notif1'): FromCall => ({ table: 'notificaciones', result: ok({ id }) });
const notifUpdate = (): FromCall => ({ table: 'notificaciones', result: ok() });
const pushOmitida = (): FromCall[] => [notifLookup(null), notifInsert('notif-push')];

const honorario = {
  id: 'hon1',
  cliente_id: 'cli1',
  monto: 50000,
  descripcion: 'Honorarios Julio 2026',
  fecha_vencimiento: '2026-07-10',
  cliente: { nombre: 'Juan', email: 'cliente@mail.com' },
};

beforeEach(() => {
  sb.reset();
  sendNuevoHonorario.mockReset();
  sendRecordatorioHonorario.mockReset();
  sendHonorarioVencidoCliente.mockReset();
  sendPushToUser.mockReset();
  sendPushToUser.mockResolvedValue('omitida');
});

describe('cron · procesarHonorariosVencidos', () => {
  it('marca vencidos primero (desacoplado) y avisa al CLIENTE por email + push', async () => {
    sendHonorarioVencidoCliente.mockResolvedValue('enviada');
    sb.queue([
      transicion(),
      selectHonorarios([honorario]),
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
      ...pushOmitida(),
    ]);

    await procesarHonorariosVencidos();

    expect(sb.calls[0].table).toBe('honorarios');
    expect(sb.calls[0].op).toBe('update');
    expect(sb.calls[0].payload).toMatchObject({ estado: 'vencido' });

    expect(sendHonorarioVencidoCliente).toHaveBeenCalledWith('cliente@mail.com', {
      nombre: 'Juan',
      descripcion: 'Honorarios Julio 2026',
    });
    expect(sendPushToUser).toHaveBeenCalledWith(
      'cli1',
      expect.objectContaining({ url: '/cliente/honorarios' }),
    );

    // Fila con target honorario_id y tipo vencido_cliente.
    const ins = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'insert');
    expect(ins?.payload).toMatchObject({ honorario_id: 'hon1', user_id: 'cli1', tipo: 'vencido_cliente' });
  });

  it('acota el backlog: solo vencidos de los últimos 30 días', async () => {
    sb.queue([transicion(), selectHonorarios([])]);

    await procesarHonorariosVencidos();

    const select = sb.calls[1];
    expect(select.filters).toContainEqual(['eq', 'estado', 'vencido']);
    expect(select.filters.some(([op, campo]) => op === 'gte' && campo === 'fecha_vencimiento')).toBe(true);
  });

  it('sin email de cliente: el push corre igual, no rompe', async () => {
    sb.queue([
      transicion(),
      selectHonorarios([{ ...honorario, cliente: null }]),
      ...pushOmitida(),
    ]);

    await procesarHonorariosVencidos();

    expect(sendHonorarioVencidoCliente).not.toHaveBeenCalled();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });
});

describe('cron · notificarHonorariosNuevos', () => {
  it('avisa los pendientes del período en cobro (mes anterior) y los sueltos, por email + push', async () => {
    sendNuevoHonorario.mockResolvedValue('enviada');
    sendPushToUser.mockResolvedValue('enviada');
    sb.queue([
      selectHonorarios([honorario]),
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
      notifLookup(null),
      notifInsert('notif-push'),
      notifUpdate(),
    ]);

    await notificarHonorariosNuevos();

    // Filtra pendientes del período en cobro (mes vencido: el mes anterior, primer
    // día) e incluye los sueltos (periodo null) en el mismo .or().
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estado', 'pendiente']);
    expect(sb.calls[0].filters.some(([op, expr]) =>
      op === 'or' && typeof expr === 'string' &&
      expr.includes('periodo.is.null') && /periodo\.eq\.\d{4}-\d{2}-01/.test(expr),
    )).toBe(true);

    expect(sendNuevoHonorario).toHaveBeenCalledWith('cliente@mail.com', {
      nombre: 'Juan',
      descripcion: 'Honorarios Julio 2026',
      monto: 50000,
      fecha_vencimiento: '2026-07-10',
    });
    const updates = sb.calls.filter((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(updates).toHaveLength(2);
  });

  it('dedup: aviso ya enviado en ambos canales no reenvía', async () => {
    sb.queue([
      selectHonorarios([honorario]),
      notifLookup({ id: 'n1', estado_envio: 'enviada', intentos: 1 }),
      notifLookup({ id: 'n2', estado_envio: 'enviada', intentos: 1 }),
    ]);

    await notificarHonorariosNuevos();

    expect(sendNuevoHonorario).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});

describe('cron · procesarHonorariosRecordatorios', () => {
  it('avisa pendientes que vencen en 3 días por email + push', async () => {
    sendRecordatorioHonorario.mockResolvedValue('enviada');
    sb.queue([
      selectHonorarios([honorario]),
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
      ...pushOmitida(),
    ]);

    await procesarHonorariosRecordatorios();

    expect(sb.calls[0].filters).toContainEqual(['eq', 'estado', 'pendiente']);
    expect(sb.calls[0].filters.some(([op, campo]) => op === 'eq' && campo === 'fecha_vencimiento')).toBe(true);

    expect(sendRecordatorioHonorario).toHaveBeenCalledWith('cliente@mail.com', {
      nombre: 'Juan',
      descripcion: 'Honorarios Julio 2026',
      fecha_vencimiento: '2026-07-10',
    });
    expect(sendPushToUser).toHaveBeenCalledWith(
      'cli1',
      expect.objectContaining({ body: expect.stringContaining('10/07/2026') }),
    );
    // Tipo correcto en la fila.
    const ins = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'insert');
    expect(ins?.payload).toMatchObject({ tipo: 'recordatorio_3dias', honorario_id: 'hon1' });
  });

  it('push falla → fila push queda fallida y se reintentará', async () => {
    sendRecordatorioHonorario.mockResolvedValue('enviada');
    sendPushToUser.mockRejectedValue(new Error('push service 500'));
    sb.queue([
      selectHonorarios([honorario]),
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
      notifLookup(null),
      notifInsert('notif-push'),
      notifUpdate(),
    ]);

    await procesarHonorariosRecordatorios();

    const updFallida = sb.calls.find(
      (c) => c.table === 'notificaciones' && c.op === 'update' && c.payload?.estado_envio === 'fallida',
    );
    expect(updFallida?.payload.ultimo_error).toContain('push service 500');
  });
});
