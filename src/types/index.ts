export type Role = 'admin' | 'contador' | 'cliente';
export type EstadoImpuesto = 'pendiente' | 'vencido' | 'pagado';
export type TipoNotificacion = 'nuevo' | 'recordatorio_3dias' | 'vencido';
export type Obligacion = 'monotributo' | 'iva' | 'autonomos' | 'ingresos_brutos';

export interface User {
  id: string;
  estudio_id: string | null;
  nombre: string;
  email: string;
  role: Role;
  cuit: string | null;
  telefono: string | null;
  activo: boolean;
  created_at: string;
}

export interface Estudio {
  id: string;
  nombre: string;
  activo: boolean;
  created_at: string;
}

export interface Impuesto {
  id: string;
  estudio_id: string;
  cliente_id: string;
  creado_por: string;
  tipo: string;
  monto: number;
  fecha_vencimiento: string;
  descripcion: string | null;
  link_pago: string | null;
  estado: EstadoImpuesto;
  pagado_at: string | null;
  pagado_por: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vencimiento {
  id: string;
  estudio_id: string;
  obligacion: Obligacion;
  terminacion_cuit: number | null;
  anio: number;
  mes: number;
  fecha_vencimiento: string;
  created_at: string;
}

export interface Notificacion {
  id: string;
  impuesto_id: string;
  user_id: string;
  tipo: TipoNotificacion;
  canal: string;
  enviada_at: string;
}

export interface JwtPayload {
  id: string;
  email: string;
  role: Role;
  estudio_id: string | null;
}
