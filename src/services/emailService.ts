import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

const FROM = process.env.EMAIL_FROM ?? 'Sistema Contable <notificaciones@tudominio.com>';

/**
 * Resultado de un intento de envío por un canal:
 *  - 'enviada': el canal mandó el mensaje OK.
 *  - 'omitida': el canal está apagado (no es un fallo). El llamador NO debe marcar
 *    la notificación como enviada — así, al prender el canal, se manda recién ahí (B3 sec.).
 * Un fallo real de envío se propaga como throw (el llamador lo marca 'fallida' y reintenta).
 */
export type ResultadoCanal = 'enviada' | 'omitida';

function emailsEnabled(): boolean {
  return process.env.EMAILS_ENABLED === 'true';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatFecha(fecha: string): string {
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y}`;
}

function formatMonto(monto: number): string {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(monto);
}

export async function sendNuevoImpuesto(
  to: string,
  data: {
    nombre: string;
    tipo: string;
    monto: number;
    fecha_vencimiento: string;
  }
): Promise<ResultadoCanal> {
  if (!emailsEnabled()) {
    console.log(`[email] sendNuevoImpuesto SKIP (EMAILS_ENABLED!=true) → ${to} | ${data.tipo}`);
    return 'omitida';
  }

  const fechaFormateada = formatFecha(data.fecha_vencimiento);
  const montoFormateado = formatMonto(data.monto);
  const nombre = escapeHtml(data.nombre);
  const tipo = escapeHtml(data.tipo);

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Nuevo vencimiento: ${tipo}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#1e293b">Nuevo vencimiento asignado</h2>
          <p>Hola <strong>${nombre}</strong>,</p>
          <p>Tu contador registró un nuevo vencimiento para tu cuenta:</p>
          <table style="border-collapse:collapse;width:100%;margin:16px 0">
            <tr>
              <td style="padding:8px 12px;background:#f1f5f9;font-weight:600;width:40%">Tipo</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${tipo}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#f1f5f9;font-weight:600">Monto</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${montoFormateado}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;background:#f1f5f9;font-weight:600">Vencimiento</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${fechaFormateada}</td>
            </tr>
          </table>
          <p style="color:#64748b;font-size:13px;margin-top:32px">Este es un mensaje automático del Sistema de Gestión Contable.</p>
        </div>
      `,
    });
    console.log(`[email] sendNuevoImpuesto OK → ${to} | ${tipo}`);
    return 'enviada';
  } catch (err) {
    console.error(`[email] sendNuevoImpuesto FAIL → ${to} | ${data.tipo}`, err);
    throw err;
  }
}

export async function sendRecordatorio(
  to: string,
  data: {
    nombre: string;
    tipo: string;
    fecha_vencimiento: string;
  }
): Promise<ResultadoCanal> {
  if (!emailsEnabled()) {
    console.log(`[email] sendRecordatorio SKIP (EMAILS_ENABLED!=true) → ${to} | ${data.tipo}`);
    return 'omitida';
  }

  const fechaFormateada = formatFecha(data.fecha_vencimiento);
  const nombre = escapeHtml(data.nombre);
  const tipo = escapeHtml(data.tipo);

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Recordatorio: ${tipo} vence el ${fechaFormateada}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#d97706">⏰ Recordatorio de vencimiento</h2>
          <p>Hola <strong>${nombre}</strong>,</p>
          <p>Te recordamos que tu impuesto <strong>${tipo}</strong> vence en <strong>3 días</strong>:</p>
          <p style="font-size:20px;font-weight:700;color:#dc2626">📅 ${fechaFormateada}</p>
          <p>Asegurate de tener el pago listo antes de esa fecha para evitar recargos.</p>
          <p style="color:#64748b;font-size:13px;margin-top:32px">Este es un mensaje automático del Sistema de Gestión Contable.</p>
        </div>
      `,
    });
    console.log(`[email] sendRecordatorio OK → ${to} | ${tipo} | vence ${fechaFormateada}`);
    return 'enviada';
  } catch (err) {
    console.error(`[email] sendRecordatorio FAIL → ${to} | ${data.tipo}`, err);
    throw err;
  }
}

// El destinatario es el CONTADOR (el template está redactado para él: "el impuesto X del
// cliente Y venció, gestionar el pago"). El cron pasa el email de `creado_por` (B2).
export async function sendVencido(
  to: string,
  data: {
    nombre_cliente: string;
    tipo: string;
  }
): Promise<ResultadoCanal> {
  if (!emailsEnabled()) {
    console.log(`[email] sendVencido SKIP (EMAILS_ENABLED!=true) → ${to} | ${data.tipo}`);
    return 'omitida';
  }

  const tipo = escapeHtml(data.tipo);
  const nombreCliente = escapeHtml(data.nombre_cliente);

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `⚠️ Vencimiento no pagado: ${tipo}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#dc2626">⚠️ Vencimiento no pagado</h2>
          <p>El impuesto <strong>${tipo}</strong> del cliente <strong>${nombreCliente}</strong> venció sin registrar pago.</p>
          <p>Por favor gestionar el pago a la brevedad para evitar intereses y penalidades.</p>
          <p style="color:#64748b;font-size:13px;margin-top:32px">Este es un mensaje automático del Sistema de Gestión Contable.</p>
        </div>
      `,
    });
    console.log(`[email] sendVencido OK → ${to} | ${tipo}`);
    return 'enviada';
  } catch (err) {
    console.error(`[email] sendVencido FAIL → ${to} | ${data.tipo}`, err);
    throw err;
  }
}
