/**
 * Parser del export AFIP "Mis Comprobantes Emitidos" (.xlsx) de un monotributista.
 *
 * Estructura típica:
 *   fila 0: título "Mis Comprobantes Emitidos - CUIT 20231414143"
 *   fila 1: encabezados ("Fecha", "Tipo", ..., "Imp. Total")
 *   fila 2+: un comprobante emitido por fila
 *
 * Para un monotributista las facturas son tipo C (sin IVA discriminado), así que la
 * facturación del período = suma de "Imp. Total". Las notas de crédito restan.
 * El parser agrega por mes (un comprobante puede tener cualquier fecha del export, que
 * puede abarcar uno o varios meses) y devuelve un total por período.
 */
import { normalizeCuit } from './validators';

const RE_FECHA = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const RE_CUIT = /\b(\d{2}[-\s]?\d{8}[-\s]?\d)\b/;

export interface MonotributoPeriodo {
  anio: number;
  mes: number;
  periodo: string; // YYYY-MM-01
  monto: number; // suma de Imp. Total (notas de crédito restan)
  comprobantes: number;
}

// Una fila de detalle (un comprobante emitido). imp_total con signo (NC negativo).
export interface MonotributoComprobante {
  periodo: string; // YYYY-MM-01
  fecha: string; // YYYY-MM-DD
  tipo: string;
  punto_venta: string;
  numero_desde: string;
  numero_hasta: string;
  doc_tipo_receptor: string;
  doc_nro_receptor: string;
  denominacion_receptor: string;
  imp_total: number; // con signo: las notas de crédito quedan negativas
}

export interface ResultadoMonotributo {
  cuit: string | null;
  periodos: MonotributoPeriodo[];
  detalle: MonotributoComprobante[];
}

export class MonotributoParseError extends Error {}

function cell(fila: unknown[], i: number): string {
  const v = fila[i];
  return v == null ? '' : String(v).trim();
}

function normHeader(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // sin tildes
    .replace(/\s+/g, ' ')
    .trim();
}

/** Número en formato es-AR ("1.234,56") o plano ("17500"). Vacío/no numérico → 0. */
function parseMonto(v: unknown): number {
  const s = (v == null ? '' : String(v)).trim();
  if (s === '') return 0;
  // Quitar todo menos dígitos, separadores y signo; "." son miles y "," es decimal.
  let t = s.replace(/[^\d.,-]/g, '');
  t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

function buscarCuit(filas: unknown[][], hasta: number): string | null {
  for (let r = 0; r < hasta; r++) {
    for (const c of filas[r] ?? []) {
      const s = c == null ? '' : String(c);
      if (!/cuit/i.test(s)) continue;
      const m = s.match(RE_CUIT);
      if (m) {
        const norm = normalizeCuit(m[1]);
        if (norm) return norm;
      }
    }
  }
  return null;
}

/** Ubica la fila de encabezados (la que tiene "Fecha" y alguna columna con "imp" y "total"). */
function buscarHeader(filas: unknown[][]): { idx: number; cols: Record<string, number> } | null {
  for (let r = 0; r < Math.min(filas.length, 15); r++) {
    const fila = filas[r] ?? [];
    const headers = fila.map((c) => normHeader(c == null ? '' : String(c)));
    const find = (pred: (h: string) => boolean) => headers.findIndex(pred);
    const idxFecha = headers.indexOf('fecha');
    const idxTipo = headers.indexOf('tipo');
    const idxImpTotal = find((h) => h.includes('imp') && h.includes('total'));
    if (idxFecha !== -1 && idxImpTotal !== -1) {
      return {
        idx: r,
        cols: {
          fecha: idxFecha,
          tipo: idxTipo,
          impTotal: idxImpTotal,
          // Columnas del detalle (todas opcionales: -1 si no están).
          puntoVenta: find((h) => h.includes('punto') && h.includes('venta')),
          numeroDesde: find((h) => h.includes('numero') && h.includes('desde')),
          numeroHasta: find((h) => h.includes('numero') && h.includes('hasta')),
          docTipoReceptor: find((h) => h.includes('tipo') && h.includes('doc') && h.includes('receptor')),
          docNroReceptor: find(
            (h) => (h.includes('nro') || h.includes('numero')) && h.includes('doc') && h.includes('receptor'),
          ),
          denominacionReceptor: find((h) => h.includes('denominacion') && h.includes('receptor')),
        },
      };
    }
  }
  return null;
}

export function parsearMonotributo(filas: unknown[][]): ResultadoMonotributo {
  const header = buscarHeader(filas);
  if (!header) {
    throw new MonotributoParseError(
      'No se reconoció el formato: falta la fila de encabezados con "Fecha" e "Imp. Total".',
    );
  }

  const cuit = buscarCuit(filas, header.idx);
  const {
    fecha: cF,
    tipo: cT,
    impTotal: cImp,
    puntoVenta: cPV,
    numeroDesde: cND,
    numeroHasta: cNH,
    docTipoReceptor: cDTR,
    docNroReceptor: cDNR,
    denominacionReceptor: cDR,
  } = header.cols;

  // periodo "YYYY-MM" → acumulador.
  const acc = new Map<string, MonotributoPeriodo>();
  const detalle: MonotributoComprobante[] = [];

  for (let r = header.idx + 1; r < filas.length; r++) {
    const fila = filas[r] ?? [];
    const fechaStr = cell(fila, cF);
    const m = fechaStr.match(RE_FECHA);
    if (!m) continue; // fila vacía o no-detalle

    const dia = Number(m[1]);
    const mes = Number(m[2]);
    const anio = Number(m[3]);
    if (mes < 1 || mes > 12) continue;

    const tipo = cT >= 0 ? cell(fila, cT) : '';
    const signo = /nota de cr[eé]dito/i.test(tipo) ? -1 : 1;
    const monto = parseMonto(fila[cImp]) * signo;

    const key = `${anio}-${String(mes).padStart(2, '0')}`;
    const periodo = `${key}-01`;
    const prev = acc.get(key) ?? {
      anio,
      mes,
      periodo,
      monto: 0,
      comprobantes: 0,
    };
    prev.monto += monto;
    prev.comprobantes += 1;
    acc.set(key, prev);

    detalle.push({
      periodo,
      fecha: `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
      tipo,
      punto_venta: cPV >= 0 ? cell(fila, cPV) : '',
      numero_desde: cND >= 0 ? cell(fila, cND) : '',
      numero_hasta: cNH >= 0 ? cell(fila, cNH) : '',
      doc_tipo_receptor: cDTR >= 0 ? cell(fila, cDTR) : '',
      doc_nro_receptor: cDNR >= 0 ? cell(fila, cDNR) : '',
      denominacion_receptor: cDR >= 0 ? cell(fila, cDR) : '',
      imp_total: Math.round(monto * 100) / 100,
    });
  }

  if (acc.size === 0) {
    throw new MonotributoParseError('El archivo no tiene comprobantes con fecha válida.');
  }

  const periodos = [...acc.values()]
    .map((p) => ({ ...p, monto: Math.round(p.monto * 100) / 100 }))
    .sort((a, b) => a.periodo.localeCompare(b.periodo));

  return { cuit, periodos, detalle };
}
