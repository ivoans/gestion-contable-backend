import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM = 'Gestión Contable <no-reply@tudominio.com>';

export async function sendNuevoImpuesto(
  to: string,
  data: { nombre: string; tipo: string; monto: number; fecha_vencimiento: string }
) {
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Nuevo impuesto asignado: ${data.tipo}`,
    html: `
      <h2>Nuevo impuesto asignado</h2>
      <p>Hola ${data.nombre},</p>
      <p>Se te ha asignado un nuevo impuesto:</p>
      <ul>
        <li><strong>Tipo:</strong> ${data.tipo}</li>
        <li><strong>Monto:</strong> $${data.monto.toFixed(2)}</li>
        <li><strong>Vencimiento:</strong> ${data.fecha_vencimiento}</li>
      </ul>
    `,
  });
}

export async function sendRecordatorio(
  to: string,
  data: { nombre: string; tipo: string; fecha_vencimiento: string }
) {
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Recordatorio: ${data.tipo} vence en 3 días`,
    html: `
      <h2>Recordatorio de vencimiento</h2>
      <p>Hola ${data.nombre},</p>
      <p>Tu impuesto <strong>${data.tipo}</strong> vence el <strong>${data.fecha_vencimiento}</strong>.</p>
      <p>Recordá realizar el pago a tiempo.</p>
    `,
  });
}

export async function sendVencido(
  to: string[],
  data: { nombre: string; tipo: string }
) {
  await resend.emails.send({
    from: FROM,
    to,
    subject: `VENCIDO: ${data.tipo}`,
    html: `
      <h2>Impuesto vencido</h2>
      <p>El impuesto <strong>${data.tipo}</strong> del cliente <strong>${data.nombre}</strong> ha vencido.</p>
      <p>Por favor gestionar el pago a la brevedad.</p>
    `,
  });
}
