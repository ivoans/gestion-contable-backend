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
