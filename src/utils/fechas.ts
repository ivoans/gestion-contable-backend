// Helpers de fecha compartidos por los crons (vencimientos + honorarios).

/** Fecha de "hoy" en Argentina como YYYY-MM-DD (en-CA da ese formato). */
export function getDateAR(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

/** Suma días a una fecha YYYY-MM-DD (mediodía UTC para esquivar DST). */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Primer día del mes de "hoy" en Argentina, como YYYY-MM-01. */
export function primerDiaMesAR(): string {
  return `${getDateAR().slice(0, 7)}-01`;
}

/**
 * (anio, mes) del mes ANTERIOR a "hoy" en Argentina. Es el período que los honorarios
 * facturan a mes vencido: el 1/7 se genera "junio", que vence en julio.
 */
export function periodoAnteriorAR(): { anio: number; mes: number } {
  const [anio, mes] = getDateAR().split('-').map(Number);
  return mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
}

/** El mes siguiente a (anio, mes), con rollover de año. */
export function mesSiguiente(anio: number, mes: number): { anio: number; mes: number } {
  return mes === 12 ? { anio: anio + 1, mes: 1 } : { anio, mes: mes + 1 };
}

/** DD/MM/YYYY para textos de avisos. */
export function formatFechaCorta(fecha: string): string {
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y}`;
}

const MESES_LARGO = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** "julio 2026" para textos de avisos, desde un período YYYY-MM-DD. */
export function formatPeriodoLargo(periodo: string): string {
  const [y, m] = periodo.split('-');
  return `${MESES_LARGO[Number(m) - 1]} ${y}`;
}
