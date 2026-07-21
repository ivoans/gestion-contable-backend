import PDFDocument from 'pdfkit';
import { Aging } from '../types';

/**
 * PDF de estado de cuenta (snapshot del día, NO se persiste ni numera). Reusa el
 * encabezado del recibo (reciboPdfService): caja con logo + datos del estudio + datos
 * del cliente. Body distinto: una tabla CONCEPTO/VENCE/ESTADO/MONTO por bloque
 * ("Impuestos" y "Estudio") con subtotal, total general y resumen de aging.
 */

export interface BloquePdf {
  titulo: string;
  items: { concepto: string; fecha_vencimiento: string; estado: string; monto: number }[];
  subtotal: number;
}

export interface EstadoCuentaPdfData {
  estudio: {
    nombre: string;
    domicilio: string | null;
    telefono: string | null;
    email: string | null;
    condicion_iva: string | null;
    cuit: string | null;
  };
  cliente: {
    nombre: string;
    domicilio: string | null;
    cuit: string | null;
    telefono: string | null;
    email: string | null;
    condicion: string | null;
  };
  fecha: string; // YYYY-MM-DD
  bloques: BloquePdf[];
  total: number;
  aging: Aging | null; // resumen de antigüedad del bloque estudio
  logo?: Buffer | null;
}

function money(n: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const GRIS_BORDE = '#c9c9c9';
const GRIS_HEADER = '#ececec';
const NEGRO = '#1a1a1a';

export async function renderEstadoCuentaPdf(data: EstadoCuentaPdfData): Promise<Buffer> {
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
  const bottom = doc.page.height - doc.page.margins.bottom;
  const pad = 12;

  // ── Encabezado: logo + datos del estudio + título/fecha a la derecha ──────────
  const headTop = doc.y;
  const headH = 108;
  doc.roundedRect(left, headTop, width, headH, 3).stroke(GRIS_BORDE);

  let estudioX = left + pad;
  if (data.logo) {
    try {
      doc.image(data.logo, left + pad, headTop + 32, { fit: [110, 46] });
      estudioX = left + pad + 122;
    } catch {
      // Logo corrupto: seguimos sin logo.
    }
  }

  const estudioW = 230;
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(13);
  doc.text(data.estudio.nombre, estudioX, headTop + 14, { width: estudioW });
  doc.font('Helvetica').fontSize(8.5);
  const lineasEstudio = [
    data.estudio.domicilio ? `Domicilio: ${data.estudio.domicilio}` : null,
    data.estudio.telefono ? `Tel: ${data.estudio.telefono}` : null,
    data.estudio.email ? `Email: ${data.estudio.email}` : null,
    data.estudio.cuit ? `CUIT: ${data.estudio.cuit}` : null,
  ].filter((l): l is string => !!l);
  doc.text(lineasEstudio.join('\n'), estudioX, doc.y + 3, { width: estudioW, lineGap: 1.5 });

  const rW = 180;
  const rX = right - rW - pad;
  doc.font('Helvetica-Bold').fontSize(14);
  doc.text('ESTADO DE CUENTA', rX, headTop + 16, { width: rW, align: 'right' });
  doc.font('Helvetica').fontSize(9);
  doc.text(`Fecha: ${fechaCorta(data.fecha)}`, rX, doc.y + 4, { width: rW, align: 'right' });

  // ── Datos del cliente ────────────────────────────────────────────────────────
  const cliTop = headTop + headH + 12;
  const cliH = 84;
  doc.roundedRect(left, cliTop, width, cliH, 3).stroke(GRIS_BORDE);

  const labelW = 66;
  const fila = (label: string, valor: string | null, x: number, yy: number, valW: number): void => {
    doc.font('Helvetica-Bold').fontSize(8.5).text(label, x, yy, { width: labelW, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).text(valor ?? '', x + labelW + 8, yy, { width: valW });
  };

  const izqX = left + pad;
  const izqValW = 200;
  let y = cliTop + 12;
  fila('CLIENTE', data.cliente.nombre, izqX, y, izqValW);
  y += 14;
  fila('DOMICILIO', data.cliente.domicilio, izqX, y, izqValW);
  y += 14;
  fila('CUIT', data.cliente.cuit, izqX, y, izqValW);

  const derX = left + width / 2 + 20;
  const derValW = 150;
  let yd = cliTop + 12;
  fila('CONDICIÓN', data.cliente.condicion, derX, yd, derValW);
  yd += 14;
  fila('TELÉFONO', data.cliente.telefono, derX, yd, derValW);
  yd += 14;
  fila('CORREO', data.cliente.email, derX, yd, derValW);

  // ── Tablas por bloque ────────────────────────────────────────────────────────
  const colVence = right - 210;
  const colEstado = right - 150;
  const colMonto = right - 90; // ancho de columna monto ~90, alineada a la derecha
  const rowH = 16;

  doc.y = cliTop + cliH + 16;

  const ensureSpace = (needed: number): void => {
    if (doc.y + needed > bottom) doc.addPage();
  };

  const dibujarBloque = (bloque: BloquePdf): void => {
    ensureSpace(28 + rowH);
    // Título del bloque
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NEGRO);
    doc.text(bloque.titulo, left, doc.y, { width });
    doc.moveDown(0.2);

    // Header de la tabla
    const hTop = doc.y;
    doc.rect(left, hTop, width, 20).fillAndStroke(GRIS_HEADER, GRIS_BORDE);
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(8.5);
    doc.text('CONCEPTO', left + 6, hTop + 6, { width: colVence - left - 12 });
    doc.text('VENCE', colVence, hTop + 6, { width: 58, align: 'left' });
    doc.text('ESTADO', colEstado, hTop + 6, { width: 58, align: 'left' });
    doc.text('MONTO', colMonto, hTop + 6, { width: right - colMonto - 6, align: 'right' });
    doc.y = hTop + 20;

    doc.font('Helvetica').fontSize(8.5);
    if (bloque.items.length === 0) {
      doc.fillColor('#777').text('Sin deuda.', left + 6, doc.y + 5, { width });
      doc.y += rowH;
      doc.fillColor(NEGRO);
    } else {
      for (const it of bloque.items) {
        ensureSpace(rowH);
        const ry = doc.y;
        doc.fillColor(NEGRO);
        doc.text(it.concepto, left + 6, ry + 4, { width: colVence - left - 12, ellipsis: true, lineBreak: false });
        doc.text(fechaCorta(it.fecha_vencimiento), colVence, ry + 4, { width: 58 });
        doc.fillColor(it.estado === 'vencido' ? '#b91c1c' : '#555');
        doc.text(cap(it.estado), colEstado, ry + 4, { width: 58 });
        doc.fillColor(NEGRO);
        doc.text(money(it.monto), colMonto, ry + 4, { width: right - colMonto - 6, align: 'right' });
        doc.moveTo(left, ry + rowH).lineTo(right, ry + rowH).stroke(GRIS_BORDE);
        doc.y = ry + rowH;
      }
    }

    // Subtotal
    ensureSpace(rowH + 4);
    const sy = doc.y + 3;
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(`Subtotal ${bloque.titulo.toLowerCase()}`, colVence - 60, sy, {
      width: colMonto - (colVence - 60) - 6,
      align: 'right',
    });
    doc.text(money(bloque.subtotal), colMonto, sy, { width: right - colMonto - 6, align: 'right' });
    doc.y = sy + rowH + 6;
  };

  for (const bloque of data.bloques) dibujarBloque(bloque);

  // ── Total general ────────────────────────────────────────────────────────────
  ensureSpace(30);
  const tTop = doc.y + 2;
  const totLabelX = colVence - 60;
  doc.rect(totLabelX - 6, tTop - 4, right - (totLabelX - 6), 22).fill(GRIS_HEADER);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(11);
  doc.text('TOTAL ADEUDADO', totLabelX, tTop + 2, {
    width: colMonto - totLabelX - 6,
    align: 'right',
  });
  doc.text(money(data.total), colMonto, tTop + 2, { width: right - colMonto - 6, align: 'right' });
  doc.y = tTop + 30;

  // ── Aging (antigüedad de honorarios) ─────────────────────────────────────────
  if (data.aging) {
    ensureSpace(26);
    const a = data.aging;
    const resumen = [
      `Por vencer ${money(a.por_vencer)}`,
      `0-30 ${money(a.d0_30)}`,
      `31-60 ${money(a.d31_60)}`,
      `61-90 ${money(a.d61_90)}`,
      `+90 ${money(a.d90_mas)}`,
    ].join('   |   ');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555');
    doc.text('Antigüedad de honorarios', left, doc.y, { width });
    doc.font('Helvetica').fontSize(8).fillColor('#555');
    doc.text(resumen, left, doc.y + 1, { width });
    doc.fillColor(NEGRO);
  }

  doc.moveDown(1);
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#888');
  doc.text('Documento informativo. No válido como comprobante fiscal.', left, doc.y, { width });

  doc.end();
  return done;
}
