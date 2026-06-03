// tests/helpers/factories.ts
import jwt from 'jsonwebtoken';
import type { User, Impuesto, Vencimiento, JwtPayload, Role, EstadoImpuesto } from '../../src/types';

let counter = 0;
const nextId = () => `id-${++counter}-${Date.now()}`;

export function makeUser(overrides: Partial<User> = {}): User {
  const id = overrides.id ?? nextId();
  const role: Role = overrides.role ?? 'contador';
  return {
    id,
    estudio_id: role === 'admin' ? null : 'estudio-1',
    nombre: 'Test User',
    email: `${id}@test.local`,
    role,
    cuit: null,
    condicion_fiscal: null,
    categoria: null,
    telefono: null,
    activo: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function makeImpuesto(overrides: Partial<Impuesto> = {}): Impuesto {
  const id = overrides.id ?? nextId();
  const estado: EstadoImpuesto = overrides.estado ?? 'pendiente';
  return {
    id,
    estudio_id: 'estudio-1',
    cliente_id: 'cliente-1',
    creado_por: 'contador-1',
    tipo: 'IVA',
    monto: 1000,
    fecha_vencimiento: '2030-01-15',
    descripcion: null,
    link_pago: null,
    estado,
    pagado_at: estado === 'pagado' ? new Date().toISOString() : null,
    pagado_por: estado === 'pagado' ? 'contador-1' : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export function makeVencimiento(overrides: Partial<Vencimiento> = {}): Vencimiento {
  const id = overrides.id ?? nextId();
  return {
    id,
    estudio_id: 'estudio-1',
    obligacion: 'iva',
    terminacion_cuit: 0,
    anio: 2026,
    mes: 6,
    fecha_vencimiento: '2026-06-15',
    created_at: new Date().toISOString(),
    ...overrides,
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
