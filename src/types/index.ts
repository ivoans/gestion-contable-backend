export type Role = 'admin' | 'contador' | 'cliente';
export type CondicionFiscal = 'monotributista' | 'responsable_inscripto';
export type EstadoImpuesto = 'borrador' | 'pendiente' | 'vencido' | 'pagado';
export type TipoNotificacion =
  | 'nuevo'
  | 'recordatorio_3dias'
  | 'vencido'
  | 'vencido_cliente'
  | 'generacion_digest';
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
  domicilio: string | null;
  activo: boolean;
  created_at: string;
}

export interface Estudio {
  id: string;
  nombre: string;
  activo: boolean;
  // Identidad fiscal para el recibo de cobranza (migración 014).
  domicilio: string | null;
  cuit: string | null;
  telefono: string | null;
  email: string | null;
  condicion_iva: string | null;
  inicio_actividades: string | null;
  logo_path: string | null;
  recibo_punto_venta: number;
  recibo_proximo_numero: number;
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
// periodo NULL = honorario SUELTO (sin plan, con descripcion obligatoria).
export interface Honorario {
  id: string;
  estudio_id: string;
  cliente_id: string;
  creado_por: string | null;
  periodo: string | null;
  monto: number;
  fecha_vencimiento: string;
  descripcion: string | null;
  estado: EstadoHonorario;
  pagado_at: string | null;
  pagado_por: string | null;
  created_at: string;
  updated_at: string;
}

// Recibo de cobranza emitido al confirmar el cobro de un honorario (migración 014).
export interface Recibo {
  id: string;
  estudio_id: string;
  honorario_id: string;
  cliente_id: string;
  emitido_por: string | null;
  punto_venta: number;
  numero: number;
  fecha: string;
  metodo_pago: string;
  concepto: string;
  monto: number;
  storage_path: string;
  created_at: string;
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

// Recibo de sueldo cargado por la contadora (módulo referencial, E3 / migración 015).
// El cliente lo ve en solo lectura. El PDF (opcional) vive en Storage; acá la metadata.
export interface Sueldo {
  id: string;
  estudio_id: string;
  cliente_id: string;
  empleado: string;
  periodo: string; // YYYY-MM-DD (primer día del mes)
  monto: number;
  storage_path: string | null;
  mime: string | null;
  size_bytes: number | null;
  original_name: string | null;
  created_at: string;
  updated_at: string;
}

// ── Estado de cuenta / cuenta corriente (no se persiste; se arma en memoria) ──
export type OrigenDeuda = 'impuesto' | 'honorario';

// Una obligación adeudada (impuesto o honorario) dentro del estado de cuenta.
export interface DeudaItem {
  id: string;
  origen: OrigenDeuda;
  concepto: string;
  fecha_vencimiento: string;
  monto: number;
  estado: string; // 'pendiente' | 'vencido'
  dias_vencido: number; // 0 si todavía no venció
}

export interface BloqueDeuda {
  items: DeudaItem[];
  subtotal: number;
}

// Buckets de antigüedad de deuda. por_vencer = aún no vencida.
export interface Aging {
  por_vencer: number;
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90_mas: number;
}

// Estado de cuenta de un cliente: dos bloques (impuestos + estudio) + total + aging.
// El aging es SOLO del bloque estudio (honorarios) — las cobranzas reales del estudio.
export interface EstadoCuenta {
  cliente_id: string;
  impuestos: BloqueDeuda;
  estudio: BloqueDeuda;
  total: number;
  aging: Aging;
  generado_at: string;
}

// Fila del dashboard global de cobranzas del contador (un cliente con deuda de honorarios).
export interface CobranzaCliente {
  cliente_id: string;
  nombre: string;
  telefono: string | null;
  saldo: number;
  aging: Aging;
}

export interface JwtPayload {
  id: string;
  email: string;
  role: Role;
  estudio_id: string | null;
  // NO viaja en el token: la carga `authenticate` desde la DB (getEstadoActivo)
  // porque puede cambiar durante la sesión. Undefined fuera de un request.
  condicion_fiscal?: CondicionFiscal | null;
}
