// tests/cron.test.ts — entrega confiable de notificaciones del cron (B2/B3 de AUDIT.md).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseMock, FromCall } from './helpers/supabaseMock';

const { sb } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock() as SupabaseMock };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));

// Canales mockeados: controlamos enviada / omitida (canal off) / throw (fallo real).
const { sendVencido, sendVencidoCliente, sendRecordatorio, sendGeneracionDigest, sendPushToUser } = vi.hoisted(() => ({
  sendVencido: vi.fn(),
  sendVencidoCliente: vi.fn(),
  sendRecordatorio: vi.fn(),
  sendGeneracionDigest: vi.fn(),
  sendPushToUser: vi.fn(),
}));
vi.mock('../src/services/emailService', () => ({
  sendVencido,
  sendVencidoCliente,
  sendRecordatorio,
  sendGeneracionDigest,
}));
vi.mock('../src/services/pushService', () => ({ sendPushToUser }));

import {
  procesarVencidos,
  procesarRecordatorios,
  notificarGeneracionDigest,
} from '../src/jobs/vencimientosCron';

const ok = (data: unknown = null): FromCall['result'] => ({ data, error: null });

// Helpers para encolar la secuencia de from() de un impuesto vencido.
const transicion = (): FromCall => ({ table: 'impuestos', result: ok() });
const selectVencidos = (rows: unknown[]): FromCall => ({ table: 'impuestos', result: ok(rows) });
const notifLookup = (row: unknown): FromCall => ({ table: 'notificaciones', result: ok(row) });
const notifInsert = (id = 'notif1'): FromCall => ({ table: 'notificaciones', result: ok({ id }) });
const notifUpdate = (): FromCall => ({ table: 'notificaciones', result: ok() });

// El aviso push al cliente corre SIEMPRE (no depende del email). Con el default
// 'omitida' (sin subs) consume lookup + insert y deja la fila pendiente.
const pushOmitida = (): FromCall[] => [notifLookup(null), notifInsert('notif-push')];

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
    sendVencidoCliente.mockReset();
    sendPushToUser.mockReset();
    sendPushToUser.mockResolvedValue('omitida');
  });

  it('B2: el aviso de vencido va al CONTADOR (creado_por), no al cliente', async () => {
    sendVencido.mockResolvedValue('enviada');
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate(), ...pushOmitida()]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    expect(sendVencido).toHaveBeenCalledWith('contador@estudio.com', { nombre_cliente: 'Juan', tipo: 'IVA' });
  });

  it('transición a vencido va DESACOPLADA del envío (corre primero, en bloque)', async () => {
    sendVencido.mockResolvedValue('enviada');
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate(), ...pushOmitida()]);

    await procesarVencidos();

    expect(sb.calls[0].table).toBe('impuestos');
    expect(sb.calls[0].op).toBe('update');
    expect(sb.calls[0].payload).toMatchObject({ estado: 'vencido' });
    expect(sb.calls[0].filters).toContainEqual(['eq', 'estado', 'pendiente']);
  });

  it('B3: si el envío falla, la fila queda fallida (no se pierde)', async () => {
    sendVencido.mockRejectedValue(new Error('resend 500'));
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate(), ...pushOmitida()]);

    await procesarVencidos();

    // Última escritura a notificaciones = marcar 'fallida' con el error (el push
    // posterior con 'omitida' no updatea).
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
      ...pushOmitida(),
    ]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    const upd = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ estado_envio: 'enviada', intentos: 2 });
    // No reinsertó la fila del canal email (el insert que hay es del push).
    expect(
      sb.calls.some((c) => c.table === 'notificaciones' && c.op === 'insert' && c.payload?.canal === 'email'),
    ).toBe(false);
  });

  it('B3 sec.: canal apagado (omitida) deja la fila pendiente, NO la marca enviada', async () => {
    sendVencido.mockResolvedValue('omitida');
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), ...pushOmitida()]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    // La fila se crea 'pendiente'...
    const ins = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'insert');
    expect(ins?.payload).toMatchObject({ estado_envio: 'pendiente', impuesto_id: 'imp1', user_id: 'cont1' });
    // ...y NO hay update a 'enviada' (push también quedó 'omitida').
    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op === 'update')).toBe(false);
  });

  it('dedup: si ya está enviada, no reenvía ni reinserta', async () => {
    sb.queue([
      transicion(),
      selectVencidos([impVencido]),
      notifLookup({ id: 'notif1', estado_envio: 'enviada', intentos: 1 }),
      // La fila push también existe y está enviada.
      notifLookup({ id: 'notif-push', estado_envio: 'enviada', intentos: 1 }),
    ]);

    await procesarVencidos();

    expect(sendVencido).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op !== 'select')).toBe(false);
  });

  it('dedup por canal: email ya enviada NO bloquea el push pendiente (fila propia)', async () => {
    sendPushToUser.mockResolvedValue('enviada');
    sb.queue([
      transicion(),
      selectVencidos([impVencido]),
      // email: ya enviada → skip.
      notifLookup({ id: 'notif-email', estado_envio: 'enviada', intentos: 1 }),
      // push: fila pendiente previa (p.ej. cliente sin subs hasta hoy) → se entrega.
      notifLookup({ id: 'notif-push', estado_envio: 'pendiente', intentos: 0 }),
      notifUpdate(),
    ]);

    await procesarVencidos();

    expect(sendVencido).not.toHaveBeenCalled();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    // Los lookups filtran por canal (dedup por (target, tipo, canal)).
    const lookups = sb.calls.filter((c) => c.table === 'notificaciones' && c.op === 'select');
    expect(lookups[0].filters).toContainEqual(['eq', 'canal', 'email']);
    expect(lookups[1].filters).toContainEqual(['eq', 'canal', 'push']);
    const upd = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ estado_envio: 'enviada', intentos: 1 });
  });

  it('sin email de contador: se omite ese aviso pero el push al cliente corre igual', async () => {
    sb.queue([
      transicion(),
      selectVencidos([{ ...impVencido, contador: null }]),
      ...pushOmitida(),
    ]);

    await procesarVencidos();

    expect(sendVencido).not.toHaveBeenCalled();
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });

  // Item 1: además del contador, el CLIENTE recibe una copia con texto propio.
  const impVencidoConCliente = {
    ...impVencido,
    cliente: { nombre: 'Juan', email: 'cliente@mail.com' },
  };

  it('item1: avisa también al CLIENTE (tipo vencido_cliente) con su propio texto', async () => {
    sendVencido.mockResolvedValue('enviada');
    sendVencidoCliente.mockResolvedValue('enviada');
    sb.queue([
      transicion(),
      selectVencidos([impVencidoConCliente]),
      // entrega al contador
      notifLookup(null),
      notifInsert('notif-cont'),
      notifUpdate(),
      // entrega al cliente (email)
      notifLookup(null),
      notifInsert('notif-cli'),
      notifUpdate(),
      // entrega al cliente (push)
      ...pushOmitida(),
    ]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    expect(sendVencido).toHaveBeenCalledWith('contador@estudio.com', { nombre_cliente: 'Juan', tipo: 'IVA' });
    expect(sendVencidoCliente).toHaveBeenCalledTimes(1);
    expect(sendVencidoCliente).toHaveBeenCalledWith('cliente@mail.com', { nombre: 'Juan', tipo: 'IVA' });

    // La copia al cliente es una fila de notificación independiente (dedup por tipo).
    const insertCli = sb.calls.find(
      (c) => c.table === 'notificaciones' && c.op === 'insert' && c.payload?.tipo === 'vencido_cliente',
    );
    expect(insertCli?.payload).toMatchObject({
      tipo: 'vencido_cliente',
      user_id: 'cli1',
      impuesto_id: 'imp1',
      estado_envio: 'pendiente',
    });

    // Y el push va con su propia fila (canal 'push', mismo tipo).
    const insertPush = sb.calls.find(
      (c) => c.table === 'notificaciones' && c.op === 'insert' && c.payload?.canal === 'push',
    );
    expect(insertPush?.payload).toMatchObject({ tipo: 'vencido_cliente', user_id: 'cli1' });
    expect(sendPushToUser).toHaveBeenCalledWith('cli1', expect.objectContaining({ url: '/cliente' }));
  });

  it('item1: el aviso al cliente es independiente del del contador (uno falla, el otro va)', async () => {
    sendVencido.mockRejectedValue(new Error('resend 500')); // contador falla
    sendVencidoCliente.mockResolvedValue('enviada'); // cliente OK
    sb.queue([
      transicion(),
      selectVencidos([impVencidoConCliente]),
      notifLookup(null),
      notifInsert('notif-cont'),
      notifUpdate(),
      notifLookup(null),
      notifInsert('notif-cli'),
      notifUpdate(),
      ...pushOmitida(),
    ]);

    await procesarVencidos();

    expect(sendVencidoCliente).toHaveBeenCalledTimes(1);
    // El contador quedó 'fallida' (se reintenta) y el cliente 'enviada': son filas distintas.
    const updCli = sb.calls.find(
      (c) => c.table === 'notificaciones' && c.op === 'update' && c.payload?.estado_envio === 'enviada',
    );
    expect(updCli).toBeTruthy();
  });

  it('item1: sin email de cliente, igual avisa al contador y no rompe', async () => {
    sendVencido.mockResolvedValue('enviada');
    // impVencido base no tiene email de cliente (el push al cliente corre igual).
    sb.queue([transicion(), selectVencidos([impVencido]), notifLookup(null), notifInsert(), notifUpdate(), ...pushOmitida()]);

    await procesarVencidos();

    expect(sendVencido).toHaveBeenCalledTimes(1);
    expect(sendVencidoCliente).not.toHaveBeenCalled();
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
    sendPushToUser.mockReset();
    sendPushToUser.mockResolvedValue('omitida');
  });

  it('el recordatorio va al CLIENTE (email + push) y registra la entrega', async () => {
    sendRecordatorio.mockResolvedValue('enviada');
    sb.queue([
      { table: 'impuestos', result: ok([impProximo]) },
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
      ...pushOmitida(),
    ]);

    await procesarRecordatorios();

    expect(sendRecordatorio).toHaveBeenCalledWith('cliente@mail.com', {
      nombre: 'Juan',
      tipo: 'IVA',
      fecha_vencimiento: '2026-06-29',
    });
    expect(sendPushToUser).toHaveBeenCalledWith(
      'cli1',
      expect.objectContaining({ body: expect.stringContaining('29/06/2026') }),
    );
    const upd = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ estado_envio: 'enviada' });
  });

  it('B3 sec.: con canal apagado no marca enviada', async () => {
    sendRecordatorio.mockResolvedValue('omitida');
    sb.queue([{ table: 'impuestos', result: ok([impProximo]) }, notifLookup(null), notifInsert(), ...pushOmitida()]);

    await procesarRecordatorios();

    expect(sb.calls.some((c) => c.table === 'notificaciones' && c.op === 'update')).toBe(false);
  });

  it('push enviada: marca la fila push como enviada', async () => {
    sendRecordatorio.mockResolvedValue('enviada');
    sendPushToUser.mockResolvedValue('enviada');
    sb.queue([
      { table: 'impuestos', result: ok([impProximo]) },
      notifLookup(null),
      notifInsert(),
      notifUpdate(),
      notifLookup(null),
      notifInsert('notif-push'),
      notifUpdate(),
    ]);

    await procesarRecordatorios();

    const updates = sb.calls.filter((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(updates).toHaveLength(2);
    expect(updates.every((c) => c.payload?.estado_envio === 'enviada')).toBe(true);
  });
});

describe('cron · notificarGeneracionDigest', () => {
  const borrador = (id: string, cliente_id: string, tipo: string, email = `${cliente_id}@mail.com`, nombre = 'Juan') => ({
    id,
    cliente_id,
    tipo,
    cliente: { nombre, email },
  });

  beforeEach(() => {
    sb.reset();
    sendGeneracionDigest.mockReset();
    sendGeneracionDigest.mockResolvedValue('enviada');
    sendPushToUser.mockReset();
    sendPushToUser.mockResolvedValue('omitida');
  });

  it('agrupa por cliente: UN digest email+push por cliente, anclado a su primer borrador', async () => {
    sb.queue([
      {
        table: 'impuestos',
        result: ok([
          borrador('imp1', 'cli1', 'IVA'),
          borrador('imp2', 'cli1', 'Autónomos'),
          borrador('imp3', 'cli2', 'Monotributo', 'cli2@mail.com', 'Ana'),
        ]),
      },
      // cli1: email (lookup/insert/update) + push (lookup/insert, omitida).
      notifLookup(null), notifInsert('n1'), notifUpdate(), ...pushOmitida(),
      // cli2: ídem.
      notifLookup(null), notifInsert('n2'), notifUpdate(), ...pushOmitida(),
    ]);

    await notificarGeneracionDigest('2026-06-01');

    // Un email por cliente, con TODAS sus obligaciones y el período en texto.
    expect(sendGeneracionDigest).toHaveBeenCalledTimes(2);
    expect(sendGeneracionDigest).toHaveBeenCalledWith('cli1@mail.com', {
      nombre: 'Juan',
      periodo: 'junio 2026',
      tipos: ['IVA', 'Autónomos'],
    });
    expect(sendGeneracionDigest).toHaveBeenCalledWith('cli2@mail.com', {
      nombre: 'Ana',
      periodo: 'junio 2026',
      tipos: ['Monotributo'],
    });

    // El ancla es el PRIMER borrador de cada cliente (dedup por (ancla, tipo, canal)).
    const inserts = sb.calls.filter((c) => c.table === 'notificaciones' && c.op === 'insert');
    expect(inserts.map((c) => (c.payload as { impuesto_id: string }).impuesto_id)).toEqual([
      'imp1', 'imp1', 'imp3', 'imp3',
    ]);
    expect(inserts.every((c) => (c.payload as { tipo: string }).tipo === 'generacion_digest')).toBe(true);
  });

  it('dedup: si el digest del cliente ya está enviada, no reenvía (email ni push)', async () => {
    sb.queue([
      { table: 'impuestos', result: ok([borrador('imp1', 'cli1', 'IVA')]) },
      // Email y push ya entregados: el lookup corta antes de cualquier envío.
      notifLookup({ id: 'n1', estado_envio: 'enviada', intentos: 1 }),
      notifLookup({ id: 'n2', estado_envio: 'enviada', intentos: 1 }),
    ]);

    await notificarGeneracionDigest('2026-06-01');

    expect(sendGeneracionDigest).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('sin borradores del período no hace nada', async () => {
    sb.queue([{ table: 'impuestos', result: ok([]) }]);

    await notificarGeneracionDigest('2026-06-01');

    expect(sendGeneracionDigest).not.toHaveBeenCalled();
    expect(sb.calls).toHaveLength(1);
  });

  it('fallo del email marca la fila fallida y el push igual sale', async () => {
    sendGeneracionDigest.mockRejectedValue(new Error('resend caído'));
    sb.queue([
      { table: 'impuestos', result: ok([borrador('imp1', 'cli1', 'IVA')]) },
      // Email: lookup/insert/update (fallida). Push: lookup/insert (omitida).
      notifLookup(null), notifInsert('n1'), notifUpdate(), ...pushOmitida(),
    ]);

    await notificarGeneracionDigest('2026-06-01');

    const upd = sb.calls.find((c) => c.table === 'notificaciones' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ estado_envio: 'fallida', ultimo_error: 'resend caído' });
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
  });
});
