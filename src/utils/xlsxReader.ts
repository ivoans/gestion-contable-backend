import * as XLSX from 'xlsx';

/**
 * Lee un buffer .xlsx y devuelve la PRIMERA hoja como array de arrays de celdas
 * (formato de reporte impreso que espera parsearLibroIVA). Aislado en su propio
 * helper para poder mockearlo en los tests sin depender de un .xlsx real.
 */
export function xlsxBufferAFilas(buffer: Buffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const primeraHoja = wb.SheetNames[0];
  if (!primeraHoja) return [];
  const ws = wb.Sheets[primeraHoja];
  // header:1 → filas como arrays; raw:false → celdas como string formateado;
  // defval:'' → celdas vacías presentes (no se saltean columnas).
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown[][];
}
