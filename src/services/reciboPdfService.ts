import PDFDocument from 'pdfkit';

/**
 * Render del recibo de cobranza en PDF, replicando la plantilla de Alegra (398.pdf):
 * encabezado con logo + datos del estudio, caja "X", "COBRANZA NNNNN-NNNNNNNN",
 * bloque de datos del cliente + método de pago, tabla CONCEPTO/VALOR y total.
 * Documento tipo X: "no válido como factura".
 */

export interface ReciboPdfData {
  estudio: {
    nombre: string;
    domicilio: string | null;
    telefono: string | null;
    email: string | null;
    condicion_iva: string | null;
    cuit: string | null;
    inicio_actividades: string | null; // YYYY-MM-DD
  };
  cliente: {
    nombre: string;
    domicilio: string | null;
    cuit: string | null;
    telefono: string | null;
    email: string | null;
    condicion: string | null; // texto ya resuelto ('MONOTRIBUTO' / 'RESPONSABLE INSCRIPTO')
  };
  numero: string; // '00001-00000398'
  fecha: string; // YYYY-MM-DD
  metodo_pago: string;
  concepto: string;
  monto: number;
  logo?: Buffer | null; // PNG/JPEG; si falta, el encabezado sale sin logo
}

/** Formato de número de recibo estilo Alegra: 00001-00000398. */
export function formatNumeroRecibo(puntoVenta: number, numero: number): string {
  return `${String(puntoVenta).padStart(5, '0')}-${String(numero).padStart(8, '0')}`;
}

// La plantilla de Alegra usa formato US: $60,000.00
function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

const GRIS_BORDE = '#c9c9c9';
const GRIS_HEADER = '#ececec';
const NEGRO = '#1a1a1a';

export async function renderReciboPdf(data: ReciboPdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // ── Encabezado (caja con borde) ────────────────────────────────────────────
  const headTop = doc.y;
  const headH = 118;
  doc.roundedRect(left, headTop, width, headH, 3).stroke(GRIS_BORDE);

  // Logo a la izquierda (si hay), después los datos del estudio.
  const pad = 12;
  let estudioX = left + pad;
  if (data.logo) {
    try {
      doc.image(data.logo, left + pad, headTop + 34, { fit: [110, 46] });
      estudioX = left + pad + 122;
    } catch {
      // Logo corrupto: seguimos sin logo.
    }
  }

  // Ancho acotado para que el bloque del estudio wrapee ANTES de la caja X.
  const estudioW = 145;
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(13);
  doc.text(data.estudio.nombre, estudioX, headTop + 14, { width: estudioW });
  doc.font('Helvetica').fontSize(8.5);
  const lineasEstudio = [
    data.estudio.domicilio ? `Domicilio fiscal: ${data.estudio.domicilio}` : null,
    data.estudio.telefono ? `Teléfono: ${data.estudio.telefono}` : null,
    data.estudio.email ? `Email: ${data.estudio.email}` : null,
    data.estudio.condicion_iva,
  ].filter((l): l is string => !!l);
  doc.text(lineasEstudio.join('\n'), estudioX, doc.y + 3, { width: estudioW, lineGap: 1.5 });

  // Caja "X" entre el bloque del estudio y el de la derecha.
  const xBoxSize = 34;
  const xBoxX = left + 285;
  doc.rect(xBoxX, headTop + 10, xBoxSize, xBoxSize).stroke(NEGRO);
  doc.font('Helvetica-Bold').fontSize(24);
  doc.text('X', xBoxX, headTop + 15, { width: xBoxSize, align: 'center' });

  // Bloque derecho: COBRANZA + numero, leyenda, fecha, CUIT, inicio de actividades.
  const rW = 190;
  const rX = right - rW - pad;
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text(`COBRANZA  ${data.numero}`, rX, headTop + 14, { width: rW, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(8.5);
  doc.text('Documento no válido como factura', rX, doc.y + 2, { width: rW, align: 'right' });
  doc.font('Helvetica').fontSize(8.5);
  const lineasDerecha = [
    `Fecha: ${fechaCorta(data.fecha)}`,
    data.estudio.cuit ? `CUIT: ${data.estudio.cuit}` : null,
    data.estudio.inicio_actividades
      ? `Inicio de actividades: ${fechaCorta(data.estudio.inicio_actividades)}`
      : null,
  ].filter((l): l is string => !!l);
  doc.text(lineasDerecha.join('\n'), rX, doc.y + 3, { width: rW, align: 'right', lineGap: 1.5 });

  // ── Datos del cliente (caja con borde) ─────────────────────────────────────
  const cliTop = headTop + headH + 14;
  const cliH = 118;
  doc.roundedRect(left, cliTop, width, cliH, 3).stroke(GRIS_BORDE);

  const labelW = 72;
  const filaCliente = (label: string, valor: string | null, x: number, y: number, valW: number): void => {
    doc.font('Helvetica-Bold').fontSize(8.5).text(label, x, y, { width: labelW, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).text(valor ?? '', x + labelW + 8, y, { width: valW });
  };

  let y = cliTop + 14;
  const izqX = left + pad;
  const izqValW = 220;
  filaCliente('CONTACTO', data.cliente.nombre, izqX, y, izqValW);
  y += 14;
  filaCliente('DOMICILIO', data.cliente.domicilio, izqX, y, izqValW);
  y += 24;
  filaCliente('CUIT', data.cliente.cuit, izqX, y, izqValW);
  y += 14;
  filaCliente('TELÉFONO', data.cliente.telefono, izqX, y, izqValW);
  y += 14;
  filaCliente('CORREO', data.cliente.email, izqX, y, izqValW);
  y += 14;
  filaCliente('CONDICIÓN', data.cliente.condicion, izqX, y, izqValW);

  // Método de pago a la derecha.
  const mpX = left + width / 2 + 30;
  doc.font('Helvetica-Bold').fontSize(8.5).text('MÉTODO DE PAGO', mpX, cliTop + 42, { width: 100 });
  doc.font('Helvetica').fontSize(8.5).text(data.metodo_pago, mpX + 108, cliTop + 42, { width: 130 });

  // ── Tabla CONCEPTO / VALOR ─────────────────────────────────────────────────
  const tblTop = cliTop + cliH + 14;
  const headerH = 24;
  const bodyH = 96;
  const valorW = 110;

  doc.rect(left, tblTop, width, headerH).fillAndStroke(GRIS_HEADER, GRIS_BORDE);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9);
  doc.text('CONCEPTO', left, tblTop + 8, { width: width - valorW, align: 'center' });
  doc.text('VALOR', right - valorW, tblTop + 8, { width: valorW, align: 'center' });

  doc.rect(left, tblTop + headerH, width, bodyH).stroke(GRIS_BORDE);
  doc
    .moveTo(right - valorW, tblTop)
    .lineTo(right - valorW, tblTop + headerH + bodyH)
    .stroke(GRIS_BORDE);

  doc.font('Helvetica').fontSize(9);
  doc.text(data.concepto, left + pad, tblTop + headerH + 10, { width: width - valorW - pad * 2 });
  doc.text(money(data.monto), right - valorW + 6, tblTop + headerH + 10, {
    width: valorW - 12,
    align: 'right',
  });

  // ── Totales ────────────────────────────────────────────────────────────────
  const totTop = tblTop + headerH + bodyH + 12;
  const totLabelW = 120;
  const totX = right - valorW - totLabelW;
  doc.font('Helvetica').fontSize(9);
  doc.text('Subtotal', totX, totTop, { width: totLabelW, align: 'right' });
  doc.text(money(data.monto), right - valorW + 6, totTop, { width: valorW - 12, align: 'right' });

  const totalY = totTop + 16;
  doc.rect(totX - 6, totalY - 4, totLabelW + valorW + 12, 18).fill(GRIS_HEADER);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9);
  doc.text('Total', totX, totalY, { width: totLabelW, align: 'right' });
  doc.text(money(data.monto), right - valorW + 6, totalY, { width: valorW - 12, align: 'right' });

  doc.end();
  return done;
}
