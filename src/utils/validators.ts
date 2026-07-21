const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_REGEX.test(email);
}

/**
 * Normaliza un email para guardarlo y compararlo: recorta espacios y pasa a
 * minúsculas. Se aplica en el borde (login + alta/edición de cliente) para que
 * lo almacenado y lo consultado siempre matcheen — evita cuentas duplicadas por
 * capitalización y logins que no encuentran al usuario por una mayúscula.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida que el valor sea un UUID (string con el formato canónico). Útil para
 * params/query antes de tocar la DB: un id no-UUID llega a PostgREST como `22P02`
 * y devuelve un 500 genérico en vez de un 400/404 limpio.
 */
export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/**
 * Normaliza un CUIT a sus 11 dígitos. Acepta con o sin separadores (espacios,
 * guiones, puntos). Devuelve null si no quedan exactamente 11 dígitos.
 */
export function normalizeCuit(cuit: unknown): string | null {
  if (typeof cuit !== 'string') return null;
  const stripped = cuit.replace(/[\s.\-]/g, '');
  return /^\d{11}$/.test(stripped) ? stripped : null;
}

/**
 * Valida un CUIT: 11 dígitos y dígito verificador correcto (módulo 11).
 */
export function isValidCuit(cuit: unknown): boolean {
  const normalized = normalizeCuit(cuit);
  if (!normalized) return false;

  const digits = normalized.split('').map(Number);
  const sum = CUIT_WEIGHTS.reduce((acc, weight, i) => acc + weight * digits[i], 0);

  let verificador = 11 - (sum % 11);
  if (verificador === 11) verificador = 0;
  if (verificador === 10) verificador = 9;

  return verificador === digits[10];
}
