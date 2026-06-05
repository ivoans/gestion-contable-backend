import { normalizeCuit } from './validators';

/**
 * Parser PURO de un libro IVA (compras o ventas) exportado de un software contable
 * y convertido a Excel. No lee archivos, no toca la base, no es un endpoint: recibe
 * las filas ya leídas (array de arrays de celdas) y devuelve registros + totales +
 * validación. La lectura del .xlsx y el endpoint van en otra capa.
 */

export type TipoLibro = 'compra' | 'venta';

export interface RegistroLibroIVA {
  fecha: string; // 'YYYY-MM-DD'
  tipo_comprobante: string | null;
  letra: string | null;
  numero: string | null;
  contraparte: string | null; // proveedor (compras) / cliente (ventas)
  cuit_contraparte: string | null;
  neto: number | null;
  concepto_no_gravado: number;
  iva: number | null; // Créd. Fiscal (compras) / Déb. Fiscal (ventas)
  acrecentamiento: number;
  total: number;
  retenciones_percepciones: number | null;
  op_exentas: number | null;
}

export interface TotalesLibroIVA {
  neto: number;
  concepto_no_gravado: number;
  iva: number;
  acrecentamiento: number;
  total: number;
  retenciones_percepciones: number;
  op_exentas: number;
}

export interface DiferenciaTotales {
  campo: keyof TotalesLibroIVA;
  archivo: number;
  calculado: number;
  diff: number;
}

export interface ResultadoLibroIVA {
  tipo: TipoLibro;
  periodo: { anio: number; mes: number };
  cuit: string | null; // CUIT del titular del libro, solo dígitos
  registros: RegistroLibroIVA[];
  totalesArchivo: TotalesLibroIVA; // declarados por el archivo
  sumas: TotalesLibroIVA; // calculados desde los registros
  validacion: {
    ok: boolean;
    diferencias: DiferenciaTotales[];
  };
}

// Tolerancia por redondeo al comparar totales declarados vs calculados (~1 peso).
const TOLERANCIA_TOTALES = 1;

const MESES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const RE_ENCABEZADO =
  /Libro IVA\s+(Compras|Ventas)\s+([A-Za-zÁÉÍÓÚáéíóúñ]+)\s+de\s+(\d{4})/i;
const RE_FECHA = /^\d{2}\/\d{2}\/\d{4}$/;
const RE_CUIT = /\d{2}[-.\s]?\d{8}[-.\s]?\d/;

const CAMPOS_TOTALES: (keyof TotalesLibroIVA)[] = [
  'neto',
  'concepto_no_gravado',
  'iva',
  'acrecentamiento',
  'total',
  'retenciones_percepciones',
  'op_exentas',
];

function cell(fila: unknown[], i: number): string {
  const v = fila[i];
  return v == null ? '' : String(v).trim();
}

function filaVacia(fila: unknown[]): boolean {
  return fila.every((c) => c == null || String(c).trim() === '');
}

function esFecha(s: string): boolean {
  return RE_FECHA.test(s);
}

/** 'DD/MM/YYYY' → 'YYYY-MM-DD'. */
function fechaISO(s: string): string {
  const [d, m, a] = s.split('/');
  return `${a}-${m}-${d}`;
}

/** String con punto decimal → number. Vacío o no numérico → null. */
function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Busca el CUIT del titular en las filas de metadata (antes de los títulos).
 * Aparece a veces pegado a la dirección ("GARIBALDI 639   CUIT:23-16709214-4")
 * y a veces en celda aparte. Devuelve solo los 11 dígitos o null.
 */
function buscarCuitTitular(filas: unknown[][], hasta: number): string | null {
  // Primero las celdas que mencionan "CUIT", para no confundir con otros números.
  for (let etapa = 0; etapa < 2; etapa++) {
    for (let r = 0; r < hasta; r++) {
      for (const c of filas[r] ?? []) {
        const s = c == null ? '' : String(c);
        if (etapa === 0 && !/cuit/i.test(s)) continue;
        const m = s.match(RE_CUIT);
        if (m) {
          const normalizado = normalizeCuit(m[0]);
          if (normalizado) return normalizado;
        }
      }
    }
  }
  return null;
}

export function parsearLibroIVA(filas: unknown[][]): ResultadoLibroIVA {
  // 1. Encabezado "Libro IVA Compras/Ventas <Mes> de <Año>".
  let encabezado: RegExpMatchArray | null = null;
  for (const fila of filas) {
    for (const c of fila ?? []) {
      const m = (c == null ? '' : String(c)).match(RE_ENCABEZADO);
      if (m) {
        encabezado = m;
        break;
      }
    }
    if (encabezado) break;
  }
  if (!encabezado) {
    throw new Error('El archivo no parece un libro IVA válido');
  }

  const tipo: TipoLibro = encabezado[1].toLowerCase() === 'compras' ? 'compra' : 'venta';
  const mes = MESES[encabezado[2].toLowerCase()];
  if (!mes) {
    throw new Error(`Mes no reconocido en el encabezado: "${encabezado[2]}"`);
  }
  const anio = Number(encabezado[3]);

  // 2. Fila de títulos (col0 === 'Fecha').
  const titulosIndex = filas.findIndex((fila) => cell(fila ?? [], 0).toLowerCase() === 'fecha');
  if (titulosIndex === -1) {
    throw new Error('El archivo no parece un libro IVA válido');
  }

  // 3. CUIT del titular (en la metadata previa a los títulos).
  const cuit = buscarCuitTitular(filas, titulosIndex);

  // 4. Detalle, filas secundarias y totales declarados.
  const registros: RegistroLibroIVA[] = [];
  let totalesArchivo: TotalesLibroIVA = totalesVacios();
  let ultimo: RegistroLibroIVA | null = null;

  for (let i = titulosIndex + 1; i < filas.length; i++) {
    const fila = filas[i] ?? [];
    if (filaVacia(fila)) continue;

    const c0 = cell(fila, 0);

    // Totales mensuales declarados → capturar y terminar (lo de abajo se ignora).
    if (/^totales\s+mensuales/i.test(c0)) {
      const sec = filas[i + 1] ?? [];
      totalesArchivo = {
        neto: parseNum(fila[1]) ?? 0,
        concepto_no_gravado: parseNum(fila[2]) ?? 0,
        iva: parseNum(fila[3]) ?? 0,
        acrecentamiento: parseNum(fila[4]) ?? 0,
        total: parseNum(fila[5]) ?? 0,
        // Fila secundaria: [ret/perc, IVA discrim (ignorar), op exentas].
        retenciones_percepciones: parseNum(sec[0]) ?? 0,
        op_exentas: parseNum(sec[2]) ?? 0,
      };
      break;
    }

    // Arrastre → ignorar.
    if (/^transporte$/i.test(c0)) continue;

    // Fila de detalle (empieza con fecha).
    if (esFecha(c0)) {
      const reg: RegistroLibroIVA = {
        fecha: fechaISO(c0),
        tipo_comprobante: cell(fila, 1) || null,
        letra: cell(fila, 2) || null,
        numero: cell(fila, 3) || null,
        contraparte: cell(fila, 4) || null,
        cuit_contraparte: cell(fila, 5) || null,
        neto: parseNum(fila[6]),
        concepto_no_gravado: parseNum(fila[7]) ?? 0,
        iva: parseNum(fila[8]),
        acrecentamiento: parseNum(fila[9]) ?? 0,
        total: parseNum(fila[10]) ?? 0,
        retenciones_percepciones: null,
        op_exentas: null,
      };
      registros.push(reg);
      ultimo = reg;
      continue;
    }

    // Fila secundaria: col0 no es fecha y trae valores numéricos posicionales
    // contra la fila de títulos 2 → pertenece al detalle anterior.
    const ret = parseNum(fila[0]);
    const ivaDiscrim = parseNum(fila[1]); // IGNORAR, no se guarda
    const exentas = parseNum(fila[2]);
    if (ultimo && (ret !== null || ivaDiscrim !== null || exentas !== null)) {
      if (ret !== null) ultimo.retenciones_percepciones = ret;
      if (exentas !== null) ultimo.op_exentas = exentas;
    }
  }

  // 5. Sumas calculadas desde los registros.
  const sumas = totalesVacios();
  for (const r of registros) {
    sumas.neto += r.neto ?? 0;
    sumas.concepto_no_gravado += r.concepto_no_gravado;
    sumas.iva += r.iva ?? 0;
    sumas.acrecentamiento += r.acrecentamiento;
    sumas.total += r.total;
    sumas.retenciones_percepciones += r.retenciones_percepciones ?? 0;
    sumas.op_exentas += r.op_exentas ?? 0;
  }
  for (const campo of CAMPOS_TOTALES) {
    sumas[campo] = redondear(sumas[campo]);
  }

  // 6. Validación: declarado vs calculado con tolerancia por redondeo.
  const diferencias: DiferenciaTotales[] = [];
  for (const campo of CAMPOS_TOTALES) {
    const archivo = totalesArchivo[campo];
    const calculado = sumas[campo];
    const diff = redondear(archivo - calculado);
    if (Math.abs(diff) > TOLERANCIA_TOTALES) {
      diferencias.push({ campo, archivo, calculado, diff });
    }
  }

  return {
    tipo,
    periodo: { anio, mes },
    cuit,
    registros,
    totalesArchivo,
    sumas,
    validacion: { ok: diferencias.length === 0, diferencias },
  };
}

function totalesVacios(): TotalesLibroIVA {
  return {
    neto: 0,
    concepto_no_gravado: 0,
    iva: 0,
    acrecentamiento: 0,
    total: 0,
    retenciones_percepciones: 0,
    op_exentas: 0,
  };
}
