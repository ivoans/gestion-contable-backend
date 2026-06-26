// tests/cron.test.ts — entrega confiable de notificaciones del cron (B2/B3 de AUDIT.md).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseMock, FromCall } from './helpers/supabaseMock';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));

// Canales mockeados: controlamos enviada / omitida (canal off) / throw (fallo real).
const { sendVencido, sendRecordatorio } = vi.hoisted(() => ({
  sendVencido: vi.fn(),
  sendRecordatorio: vi.fn(),
}));
vi.mock('../src/services/emailService', () => ({ sendVencido, sendRecordatorio }));

import { procesarVencidos, procesarRecordatorios } from '../src/jobs/vencimientosCron';

const ok = (data: unknown = null): FromCall['result'] => ({ data, error: null });

// Helpers para encolar la secuencia de from() de un impuesto vencido.
const transicion = (): FromCall => ({ table: 'impuestos', result: ok() });
const selectVencidos = (rows: unknown[]): FromCall => ({ table: 'impuestos', result: ok(rows) });
const notifLookup = (row: unknown): FromCall => ({ table: 'notificaciones', result: ok(row) });
const notifInsert = (id = 'notif1'): FromCall => ({ table: 'notificaciones', result: ok({ id }) });
const notifUpdate = (): FromCall => ({ table: 'notificaciones', result: ok() });

const impVencido = {
  id: 'imp1',
  cliente_id: 'cli1',
  creado_por: 'cont1',
  tipo: 'IVA',
  cliente: { nombre: 'Juan' },
  contador: { email: 'contador@estudio.com' },
};

describe('cron · procesarVencidos', () => {
  beforeEach(() => {
    sb.reset();
    sendVencido.mockReset();
  });

  it('B2: el aviso de vencido va al CONTADOR (creado_por), no al cliente', async () => {
    sendVencido.mockResolvedValue('enviada');
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate()]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    expect(sendVencido).toHaveBeenCalledWith('contador@estudio.com', { nombre_cliente: 'Juan', tipo: 'IVA' });
  });

  it('transición a vencido va DESACOPLADA del envío (corre primero, en bloque)', async () => {
    sendVencido.mockResolvedValue('enviada');
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate()]);

    await procesarVencidos();

    expect(sb.calls[0].table).toBe('impuestos');
    expect(sb.calls[0].op).toBe('update');
    expect(sb.calls[0].payload).toMatchObject({ estado: 'vencido' });
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estado', 'pendiente']);
  });

  it('B3: si el envío falla, la fila queda fallida (no se pierde)', async () => {
    sendVencido.mockRejectedValue(new Error('resend 500'));
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate()]);

    await procesarVencidos();

    // Última escritura a notificaciones = marcar 'fallida' con el error.
    const ultimaNotif = [...sb.calls].reverse().find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(ultimaNotif?.payload).toMatchObject({ estado_envio: 'fallida', intentos: 1 });
    expect(ultimaNotif?.payload.ultimo_error).toContain('resend 500');
  });

  it('B3: la corrida siguiente REINTENTA la fallida y la entrega', async () => {
    sendVencido.mockResolvedValue('enviada');
    // El lookup encuentra la fila previa 'fallida' → no inserta, va directo a enviar+marcar.
    sb.queue([
      transicion(),
      selectVencidos([impVencido]),
      notifLookup({ id: 'notif1', estado_envio: 'fallida', intentos: 1 }),
      notifUpdate(),
    ]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    const upd = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ estado_envio: 'enviada', intentos: 2 });
    // No reinsertó.
    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op === 'insert')).toBe(false);
  });

  it('B3 sec.: canal apagado (omitida) deja la fila pendiente, NO la marca enviada', async () => {
    sendVencido.mockResolvedValue('omitida');
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert()]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    // La fila se crea 'pendiente'...
    const ins = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'insert');
    expect(ins?.payload).toMatchObject({ estado_envio: 'pendiente', impuesto_id: 'imp1', user_id: 'cont1' });
    // ...y NO hay update a 'enviada' (no se consumió una 5ta llamada).
    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op === 'update')).toBe(false);
  });

  it('dedup: si ya está enviada, no reenvía ni reinserta', async () => {
    sb.queue([
      transicion(),
      selectVencidos([impVencido]),
      notifLookup({ id: 'notif1', estado_envio: 'enviada', intentos: 1 }),
    ]);

    await procesarVencidos();

    expect(sendVencido).not.toHaveBeenCalled();
    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op !== 'select')).toBe(false);
  });

  it('sin email de contador: se omite el impuesto sin romper', async () => {
    sb.queue([
      transicion(),
      selectVencidos([{ ...impVencido, contador: null }]),
    ]);

    await procesarVencidos();

    expect(sendVencido).not.toHaveBeenCalled();
  });
});

describe('cron · procesarRecordatorios', () => {
  const impProximo = {
    id: 'imp1',
    cliente_id: 'cli1',
    tipo: 'IVA',
    fecha_vencimiento: '2026-06-29',
    cliente: { email: 'cliente@mail.com', nombre: 'Juan' },
  };

  beforeEach(() => {
    sb.reset();
    sendRecordatorio.mockReset();
  });

  it('el recordatorio va al CLIENTE y registra la entrega', async () => {
    sendRecordatorio.mockResolvedValue('enviada');
    sb.queue([
      { table: 'impuestos', result: ok([impProximo]) },
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
    ]);

    await procesarRecordatorios();

    expect(sendRecordatorio).toHaveBeenCalledWith('cliente@mail.com', {
      nombre: 'Juan',
      tipo: 'IVA',
      fecha_vencimiento: '2026-06-29',
    });
    const upd = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ estado_envio: 'enviada' });
  });

  it('B3 sec.: con canal apagado no marca enviada', async () => {
    sendRecordatorio.mockResolvedValue('omitida');
    sb.queue([{ table: 'impuestos', result: ok([impProximo]) }, notifLookup(null), notifInsert()]);

    await procesarRecordatorios();

    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op === 'update')).toBe(false);
  });
});
