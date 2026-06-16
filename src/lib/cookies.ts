import { Response } from 'express';
import crypto from 'crypto';

// Nombres de las cookies de sesión.
export const TOKEN_COOKIE = 'token';
export const CSRF_COOKIE = 'csrf';

// Secure salvo en desarrollo/test (localhost sobre http). En prod (Render detrás de
// Cloudflare, https) queda Secure. NODE_ENV no seteado => se asume prod (Secure ON).
const isProd = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';

// Dominio para compartir la cookie csrf entre subdominios (front y back). En prod:
// COOKIE_DOMAIN=estudiocontablest.com.ar => la cookie csrf, seteada por api.<dominio>,
// queda legible por el JS del front en <dominio>. En dev se deja vacío (host-only localhost,
// que ya se comparte entre :5173 y :3000 porque las cookies ignoran el puerto).
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

// maxAge en ms. Espeja la expiración del JWT: remember=true => 10 días; default => 8 horas.
export function cookieMaxAgeMs(remember: boolean): number {
  return remember ? 10 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
}

function baseOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeMs,
  };
}

// Token CSRF aleatorio para el patrón double-submit. No se persiste: la seguridad está
// en que el atacante no pueda leer la cookie ni setear el header cross-site.
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Setea las dos cookies de sesión:
 *  - token: JWT en cookie httpOnly host-only del backend (JS nunca la lee → inmune a XSS).
 *  - csrf:  token legible por el front (double-submit). Lleva Domain=COOKIE_DOMAIN en prod
 *           para que el front (otro subdominio) pueda leerla con document.cookie.
 */
export function setAuthCookies(res: Response, token: string, csrf: string, remember: boolean): void {
  const maxAge = cookieMaxAgeMs(remember);
  res.cookie(TOKEN_COOKIE, token, baseOptions(maxAge));
  res.cookie(CSRF_COOKIE, csrf, { ...baseOptions(maxAge), httpOnly: false, domain: COOKIE_DOMAIN });
}

// clearCookie debe matchear path/sameSite/secure/domain para que el browser borre la cookie.
export function clearAuthCookies(res: Response): void {
  const base = { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/' };
  res.clearCookie(TOKEN_COOKIE, base);
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, domain: COOKIE_DOMAIN });
}
