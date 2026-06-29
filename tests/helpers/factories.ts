// tests/helpers/factories.ts
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import type { User, Impuesto, Vencimiento, JwtPayload, Role, EstadoImpuesto } from '../../src/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Devuelve un UUID válido. Con `label`, mapea la etiqueta legible a un UUID estable
 * dentro del proceso de test (misma etiqueta → mismo UUID), así un fixture y la URL
 * que lo referencia coinciden. Necesario desde B6: params/cliente_id se validan como
 * UUID y un id no-UUID corta con 400 antes del controller.
 */
const uuidByLabel = new Map<string, string>();
export function uuid(label?: string): string {
  if (label === undefined) return randomUUID();
  if (UUID_RE.test(label)) return label;
  let v = uuidByLabel.get(label);
  if (!v) {
    v = randomUUID();
    uuidByLabel.set(label, v);
  }
  return v;
}

const nextId = () => randomUUID();

export function makeUser(overrides: Partial<User> = {}): User {
  // El id se normaliza a UUID (estable por etiqueta) para pasar la validación de
  // params/cliente_id de B6; va después del spread para no ser pisado por overrides.id.
  const id = uuid(overrides.id);
  const role: Role = overrides.role ?? 'contador';
  return {
    estudio_id: role === 'admin' ? null : 'estudio-1',
    nombre: 'Test User',
    email: `${id}@test.local`,
    role,
    cuit: null,
    condicion_fiscal: null,
    categoria: null,
    convenio_multilateral: false,
    empleadores_sicoss: false,
    casas_particulares: false,
    telefono: null,
    activo: true,
    created_at: new Date().toISOString(),
    ...overrides,
    id,
  };
}

export function makeImpuesto(overrides: Partial<Impuesto> = {}): Impuesto {
  const id = uuid(overrides.id);
  const estado: EstadoImpuesto = overrides.estado ?? 'pendiente';
  return {
    estudio_id: 'estudio-1',
    cliente_id: 'cliente-1',
    creado_por: 'contador-1',
    tipo: 'IVA',
    monto: 1000,
    fecha_vencimiento: '2030-01-15',
    descripcion: null,
    vep: null,
    estado,
    pagado_at: estado === 'pagado' ? new Date().toISOString() : null,
    pagado_por: estado === 'pagado' ? 'contador-1' : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
    id,
  };
}

export function makeVencimiento(overrides: Partial<Vencimiento> = {}): Vencimiento {
  const id = uuid(overrides.id);
  return {
    estudio_id: 'estudio-1',
    obligacion: 'iva',
    terminacion_cuit: 0,
    anio: 2026,
    mes: 6,
    fecha_vencimiento: '2026-06-15',
    created_at: new Date().toISOString(),
    ...overrides,
    id,
  };
}

/**
 * Firma un JWT real con el secret de tests. Mismo shape que el código de prod emite.
 * Usar `bearerFor(user)` del helper auth.ts para mandarlo en header.
 */
export function makeJWT(
  user: Pick<User, 'id' | 'email' | 'role' | 'estudio_id'>,
  options: { expiresIn?: string | number; secret?: string } = {},
): string {
  const payload: JwtPayload = {
    id: user.id,
    email: user.email,
    role: user.role,
    estudio_id: user.estudio_id,
  };
  return jwt.sign(payload, options.secret ?? process.env.JWT_SECRET!, {
    expiresIn: options.expiresIn ?? '1h',
  } as jwt.SignOptions);
}
