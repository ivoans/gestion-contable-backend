export type Role = 'admin' | 'contador' | 'cliente';
export type CondicionFiscal = 'monotributista' | 'responsable_inscripto';
export type EstadoImpuesto = 'borrador' | 'pendiente' | 'vencido' | 'pagado';
export type TipoNotificacion = 'nuevo' | 'recordatorio_3dias' | 'vencido' | 'vencido_cliente';
export type CanalNotificacion = 'email' | 'push';
export type Obligacion =
  | 'monotributo'
  | 'iva'
  | 'autonomos'
  | 'ingresos_brutos'
  | 'convenio_multilateral'
  | 'empleadores_sicoss'
  | 'casas_particulares';

export interface User {
  id: string;
  estudio_id: string | null;
  nombre: string;
  email: string;
  role: Role;
  cuit: string | null;
  condicion_fiscal: CondicionFiscal | null;
  categoria: string | null;
  convenio_multilateral: boolean;
  empleadores_sicoss: boolean;
  casas_particulares: boolean;
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
  vep: string | null;
  estado: EstadoImpuesto;
  pagado_at: string | null;
  pagado_por: string | null;
  created_at: string;
  updated_at: string;
}

export type EstadoHonorario = 'pendiente' | 'vencido' | 'pagado' | 'anulado';

// Abono fijo recurrente del cliente al estudio (un plan por cliente).
export interface HonorarioPlan {
  id: string;
  estudio_id: string;
  cliente_id: string;
  monto: number;
  dia_vencimiento: number;
  activo: boolean;
  vigente_desde: string;
  created_at: string;
  updated_at: string;
}

// Instancia mensual del honorario (generada del plan o creada a mano).
export interface Honorario {
  id: string;
  estudio_id: string;
  cliente_id: string;
  creado_por: string | null;
  periodo: string;
  monto: number;
  fecha_vencimiento: string;
  descripcion: string | null;
  estado: EstadoHonorario;
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

export type MovimientoTipo = 'compra' | 'venta';
export type MovimientoOrigen = 'importado' | 'manual';

export interface Movimiento {
  id: string;
  estudio_id: string;
  cliente_id: string;
  tipo: MovimientoTipo;
  periodo: string;
  fecha: string;
  tipo_comprobante: string | null;
  letra: string | null;
  numero: string | null;
  contraparte: string | null;
  cuit_contraparte: string | null;
  neto: number | null;
  concepto_no_gravado: number;
  iva: number | null;
  acrecentamiento: number;
  total: number;
  retenciones_percepciones: number | null;
  op_exentas: number | null;
  origen: MovimientoOrigen;
  creado_por: string | null;
  created_at: string;
}

// Resumen recalculado del libro IVA de un cliente por período (no se persiste).
// Las alícuotas se infieren de iva/neto y se redondean a la tasa estándar AR más
// cercana; las que no matchean caen en el bucket 'otras'.
export interface ResumenBloque {
  cantidad: number;
  total: number;
  neto: number;
  iva: number;
  op_exentas: number;
  ret_perc: number;
}

export interface ResumenIva {
  debito: number;
  credito: number;
  saldo: number;
}

export interface ResumenPorAlicuota {
  tipo: MovimientoTipo;
  alicuota: number | 'otras';
  neto: number;
  iva: number;
  cantidad: number;
}

export interface ResumenLibroIVA {
  periodo: { anio: number; mes: number };
  ventas: ResumenBloque;
  compras: ResumenBloque;
  iva: ResumenIva;
  por_alicuota: ResumenPorAlicuota[];
}

// Un mes de la serie de tendencia multi-mes (headline numbers por período).
// Los meses sin movimientos van igual con todo en 0 para que el eje sea continuo.
export interface TendenciaMes {
  periodo: { anio: number; mes: number };
  cantidad: number;
  ventas_total: number;
  compras_total: number;
  iva_debito: number;
  iva_credito: number;
  iva_saldo: number;
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
