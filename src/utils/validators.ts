const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_REGEX.test(email);
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
