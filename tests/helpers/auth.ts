// tests/helpers/auth.ts
import type { User } from '../../src/types';
import { makeJWT } from './factories';

/**
 * Devuelve el header Authorization listo para mandar con supertest:
 *   .set('Authorization', bearerFor(user))
 *
 * Firma JWT real con process.env.JWT_SECRET (seteado en tests/setup.ts a 'test-secret').
 * El middleware authenticate verifica con el mismo secret → token válido.
 */
export function bearerFor(
  user: Pick<User, 'id' | 'email' | 'role' | 'estudio_id'>,
  options: { expiresIn?: string | number } = {},
): string {
  return `Bearer ${makeJWT(user, options)}`;
}

/** Token expirado para testear el path 401 "Token inválido o expirado". */
export function expiredBearerFor(
  user: Pick<User, 'id' | 'email' | 'role' | 'estudio_id'>,
): string {
  // expiresIn negativo = ya expirado al instante.
  return bearerFor(user, { expiresIn: -10 });
}

/** Token firmado con secret incorrecto → 401 por firma inválida. */
export function badSignatureBearerFor(
  user: Pick<User, 'id' | 'email' | 'role' | 'estudio_id'>,
): string {
  return `Bearer ${makeJWT(user, { secret: 'wrong-secret' })}`;
}

/** Header malformado: sin 'Bearer ' prefix. */
export const MALFORMED_HEADER = 'Token abc.def.ghi';
