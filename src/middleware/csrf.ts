import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { TOKEN_COOKIE, CSRF_COOKIE } from '../lib/cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Rutas que mutan estado pero no pueden exigir CSRF:
//  - /login: todavía no hay cookie csrf (recién se setea en la respuesta).
//  - /logout: solo borra cookies; exigir csrf podría dejar al usuario sin poder salir
//    si la cookie csrf venció. El riesgo de un "logout CSRF" es mínimo.
const EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/logout']);

/**
 * Protección CSRF por double-submit token.
 *
 * Solo aplica cuando la sesión viaja por COOKIE (existe la cookie token) y el método muta
 * estado. Si el request se autentica por header Bearer (clientes no-browser, tests, cron),
 * no hay cookie auto-enviada por el navegador → no hay vector CSRF → se saltea.
 *
 * El front refleja la cookie 'csrf' (legible) en el header 'x-csrf-token'. Un atacante en
 * otro origen no puede leer esa cookie ni, por lo tanto, setear el header con su valor.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.has(req.path)) return next();
  if (!req.cookies?.[TOKEN_COOKIE]) return next();

  const headerToken = req.get('x-csrf-token');
  const cookieToken = req.cookies?.[CSRF_COOKIE];

  if (!headerToken || !cookieToken || !timingSafeEqual(headerToken, cookieToken)) {
    res.status(403).json({ error: 'CSRF token inválido' });
    return;
  }

  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
