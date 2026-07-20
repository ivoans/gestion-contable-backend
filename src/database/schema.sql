-- ============================================================
-- SISTEMA DE GESTIÓN CONTABLE
-- Schema v1.0
-- ============================================================

-- Extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE role AS ENUM ('admin', 'contador', 'cliente');
CREATE TYPE estado_impuesto AS ENUM ('pendiente', 'vencido', 'pagado', 'borrador');
CREATE TYPE estado_honorario AS ENUM ('pendiente', 'vencido', 'pagado', 'anulado');
CREATE TYPE tipo_notificacion AS ENUM ('nuevo', 'recordatorio_3dias', 'vencido', 'vencido_cliente', 'generacion_digest');
CREATE TYPE condicion_fiscal AS ENUM ('monotributista', 'responsable_inscripto');
CREATE TYPE obligacion AS ENUM ('monotributo', 'iva', 'autonomos', 'ingresos_brutos');
CREATE TYPE movimiento_tipo AS ENUM ('compra', 'venta');
CREATE TYPE movimiento_origen AS ENUM ('importado', 'manual');

-- ============================================================
-- TABLA: estudios
-- ============================================================

CREATE TABLE estudios (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre                   VARCHAR(255) NOT NULL,
  activo                   BOOLEAN NOT NULL DEFAULT true,
  comprobantes_habilitados BOOLEAN NOT NULL DEFAULT false,
  -- Identidad fiscal para el encabezado del recibo de cobranza (migración 014).
  domicilio                TEXT,
  cuit                     VARCHAR(13),
  telefono                 VARCHAR(30),
  email                    VARCHAR(255),
  condicion_iva            TEXT,          -- texto libre, ej. 'MONOTRIBUTO'
  inicio_actividades       DATE,
  logo_path                TEXT,          -- objeto en el bucket 'comprobantes'
  -- Numeración correlativa de recibos por estudio (ver next_numero_recibo()).
  recibo_punto_venta       SMALLINT NOT NULL DEFAULT 1,
  recibo_proximo_numero    INTEGER  NOT NULL DEFAULT 1,
  created_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLA: users
-- ============================================================

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID REFERENCES estudios(id) ON DELETE RESTRICT,
  nombre        VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          role NOT NULL,
  cuit          VARCHAR(13),
  telefono      VARCHAR(20),
  domicilio     TEXT,                 -- para el recibo de cobranza (migración 014)
  condicion_fiscal condicion_fiscal,  -- NULL: admin/contador o cliente sin clasificar
  categoria     VARCHAR,              -- letra del monotributo, solo referencia
  activo        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- El admin global no tiene estudio, todos los demás sí
  CONSTRAINT chk_estudio_por_role CHECK (
    (role = 'admin' AND estudio_id IS NULL) OR
    (role != 'admin' AND estudio_id IS NOT NULL)
  )
);

-- ============================================================
-- TABLA: impuestos
-- ============================================================

CREATE TABLE impuestos (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creado_por        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tipo              VARCHAR(100) NOT NULL,
  monto             DECIMAL(12, 2),
  fecha_vencimiento DATE NOT NULL,
  descripcion       TEXT,
  vep               VARCHAR,
  obligacion        obligacion,  -- NULL = impuesto manual
  periodo           DATE,        -- mes declarado; NULL = manual
  estado            estado_impuesto NOT NULL DEFAULT 'pendiente',
  pagado_at         TIMESTAMP WITH TIME ZONE,
  pagado_por        UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Si NO es borrador -> monto obligatorio y > 0. Si es borrador -> monto puede ser NULL.
  CONSTRAINT chk_monto_por_estado CHECK (
    (estado <> 'borrador' AND monto IS NOT NULL AND monto > 0)
    OR estado = 'borrador'
  ),

  -- Si está pagado, tiene que tener pagado_at y pagado_por
  CONSTRAINT chk_pagado_completo CHECK (
    (estado = 'pagado' AND pagado_at IS NOT NULL AND pagado_por IS NOT NULL) OR
    (estado != 'pagado' AND pagado_at IS NULL AND pagado_por IS NULL)
  )
);

-- ============================================================
-- TABLA: honorarios_plan (abono recurrente del cliente al estudio)
-- ============================================================
-- El abono fijo configurado por cliente (un plan por cliente). La contadora edita
-- `monto`; afecta los meses que se generen de ahí en más. Ver migración 008.

CREATE TABLE honorarios_plan (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id      UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monto           DECIMAL(12, 2) NOT NULL CHECK (monto > 0),
  dia_vencimiento SMALLINT NOT NULL DEFAULT 10 CHECK (dia_vencimiento BETWEEN 1 AND 28),
  activo          BOOLEAN NOT NULL DEFAULT true,
  vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_honorarios_plan_cliente UNIQUE (cliente_id)
);

CREATE INDEX idx_honorarios_plan_estudio ON honorarios_plan (estudio_id);

-- ============================================================
-- TABLA: honorarios (instancia mensual generada del plan)
-- ============================================================

CREATE TABLE honorarios (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creado_por        UUID REFERENCES users(id) ON DELETE RESTRICT,  -- NULL = generado por cron
  -- Primer día del mes facturado. NULL = honorario SUELTO (sin plan, migración 014);
  -- el UNIQUE de abajo no aplica a NULL, así que los sueltos no chocan con el abono.
  periodo           DATE,
  monto             DECIMAL(12, 2) NOT NULL CHECK (monto > 0),
  fecha_vencimiento DATE NOT NULL,
  descripcion       TEXT,
  estado            estado_honorario NOT NULL DEFAULT 'pendiente',
  pagado_at         TIMESTAMP WITH TIME ZONE,
  pagado_por        UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_honorarios_cliente_periodo UNIQUE (cliente_id, periodo),

  CONSTRAINT chk_honorario_pagado_completo CHECK (
    (estado = 'pagado' AND pagado_at IS NOT NULL AND pagado_por IS NOT NULL) OR
    (estado <> 'pagado' AND pagado_at IS NULL AND pagado_por IS NULL)
  )
);

CREATE INDEX idx_honorarios_cliente ON honorarios (cliente_id);
CREATE INDEX idx_honorarios_estudio ON honorarios (estudio_id);
CREATE INDEX idx_honorarios_estado ON honorarios (estado);
CREATE INDEX idx_honorarios_cron ON honorarios (estado, fecha_vencimiento)
  WHERE estado = 'pendiente';

-- ============================================================
-- TABLA: comprobantes_pago
-- ============================================================
-- Metadata de los comprobantes que sube el cliente. El archivo vive en Supabase
-- Storage (bucket privado 'comprobantes'); acá solo el path + datos chicos. Cuelga de
-- un impuesto O de un honorario (exactamente uno). Un comprobante por target
-- (re-subir reemplaza). Ver migraciones 007 y 008.

CREATE TABLE comprobantes_pago (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  impuesto_id   UUID REFERENCES impuestos(id) ON DELETE CASCADE,
  honorario_id  UUID REFERENCES honorarios(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subido_por    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_path  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  original_name TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Exactamente uno de los dos targets.
  CONSTRAINT chk_comprobante_target CHECK (
    (impuesto_id IS NOT NULL AND honorario_id IS NULL) OR
    (impuesto_id IS NULL AND honorario_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_comprobante_por_impuesto
  ON comprobantes_pago (impuesto_id) WHERE impuesto_id IS NOT NULL;
CREATE UNIQUE INDEX uq_comprobante_por_honorario
  ON comprobantes_pago (honorario_id) WHERE honorario_id IS NOT NULL;
CREATE INDEX idx_comprobantes_impuesto ON comprobantes_pago (impuesto_id);
CREATE INDEX idx_comprobantes_honorario ON comprobantes_pago (honorario_id);

-- ============================================================
-- TABLA: recibos (recibo de cobranza de honorarios)
-- ============================================================
-- Emitido al confirmar el cobro de un honorario (réplica del recibo X de Alegra).
-- El PDF vive en Storage (bucket 'comprobantes', <estudio>/recibos/...). Numeración
-- correlativa por estudio vía next_numero_recibo(). Ver migración 014.

CREATE TABLE recibos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  honorario_id  UUID NOT NULL REFERENCES honorarios(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  emitido_por   UUID REFERENCES users(id) ON DELETE RESTRICT,
  punto_venta   SMALLINT NOT NULL,
  numero        INTEGER NOT NULL,
  fecha         DATE NOT NULL,
  metodo_pago   TEXT NOT NULL,
  concepto      TEXT NOT NULL,
  monto         DECIMAL(12, 2) NOT NULL,
  storage_path  TEXT NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Un recibo por honorario; revertir el cobro borra el recibo.
  CONSTRAINT uq_recibo_por_honorario UNIQUE (honorario_id),
  CONSTRAINT uq_recibo_numero UNIQUE (estudio_id, punto_venta, numero)
);

CREATE INDEX idx_recibos_estudio ON recibos (estudio_id);
CREATE INDEX idx_recibos_cliente ON recibos (cliente_id);

-- Numeración atómica por estudio. Si el insert posterior del recibo falla queda un
-- hueco en la numeración; aceptado.
CREATE FUNCTION next_numero_recibo(p_estudio_id UUID) RETURNS INTEGER
LANGUAGE sql AS $$
  UPDATE estudios
  SET recibo_proximo_numero = recibo_proximo_numero + 1
  WHERE id = p_estudio_id
  RETURNING recibo_proximo_numero - 1;
$$;

-- ============================================================
-- TABLA: vencimientos (calendario que carga la contadora)
-- ============================================================

CREATE TABLE vencimientos (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  obligacion        obligacion NOT NULL,
  terminacion_cuit  SMALLINT CHECK (terminacion_cuit BETWEEN 0 AND 9),  -- NULL = "todos"
  anio              INT NOT NULL,
  mes               SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  fecha_vencimiento DATE NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- NULLS NOT DISTINCT (PG15+): la fila "todos" (terminacion_cuit NULL) no se duplica.
  CONSTRAINT uq_vencimientos UNIQUE NULLS NOT DISTINCT
    (estudio_id, obligacion, terminacion_cuit, anio, mes)
);

-- ============================================================
-- TABLA: notificaciones
-- ============================================================

-- Entrega desacoplada (ver migración 009): cada aviso lleva su estado_envio y se
-- reintenta hasta entregarse. Cuelga de un impuesto O de un honorario (exactamente uno).
-- Desde la 012 el dedup es por (target, tipo, canal): el mismo aviso puede existir
-- una vez por canal (email/push), cada uno con su propio estado/reintento.
CREATE TABLE notificaciones (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  impuesto_id  UUID REFERENCES impuestos(id) ON DELETE CASCADE,
  honorario_id UUID REFERENCES honorarios(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo         tipo_notificacion NOT NULL,
  canal        VARCHAR(20) NOT NULL DEFAULT 'email'
    CHECK (canal IN ('email', 'push')),
  estado_envio VARCHAR(20) NOT NULL DEFAULT 'pendiente'
    CHECK (estado_envio IN ('pendiente', 'enviada', 'fallida')),
  intentos     INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  enviada_at   TIMESTAMP WITH TIME ZONE,
  CONSTRAINT chk_notif_target CHECK ((impuesto_id IS NOT NULL) <> (honorario_id IS NOT NULL))
);

CREATE UNIQUE INDEX uq_notif_impuesto_tipo_canal
  ON notificaciones (impuesto_id, tipo, canal) WHERE impuesto_id IS NOT NULL;
CREATE UNIQUE INDEX uq_notif_honorario_tipo_canal
  ON notificaciones (honorario_id, tipo, canal) WHERE honorario_id IS NOT NULL;
CREATE INDEX idx_notif_pendientes ON notificaciones (estado_envio)
  WHERE estado_envio <> 'enviada';

-- ============================================================
-- TABLA: push_subscriptions (Web Push, migración 012)
-- ============================================================

-- Una fila por endpoint de navegador (un usuario puede tener varias: teléfono +
-- desktop). endpoint UNIQUE permite upsert de re-suscripción y traspaso al user
-- logueado actual. Las subs muertas (404/410 del push service) se limpian al enviar.
CREATE TABLE push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_push_subs_user ON push_subscriptions (user_id);

-- ============================================================
-- TABLA: movimientos (libro IVA compras/ventas)
-- ============================================================

CREATE TABLE movimientos (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id                UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id                UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tipo                      movimiento_tipo NOT NULL,
  periodo                   DATE NOT NULL,            -- primer día del mes del libro
  fecha                     DATE NOT NULL,            -- fecha del comprobante (puede ser de otro mes)
  tipo_comprobante          TEXT,
  letra                     TEXT,
  numero                    TEXT,
  contraparte               TEXT,
  cuit_contraparte          TEXT,
  neto                      NUMERIC(15, 2),
  concepto_no_gravado       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  iva                       NUMERIC(15, 2),
  acrecentamiento           NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total                     NUMERIC(15, 2) NOT NULL,
  retenciones_percepciones  NUMERIC(15, 2),
  op_exentas                NUMERIC(15, 2),
  origen                    movimiento_origen NOT NULL,
  creado_por                UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at                TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ============================================================
-- ÍNDICES
-- ============================================================

-- users
CREATE INDEX idx_users_estudio_id ON users(estudio_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_email ON users(email);

-- impuestos
CREATE INDEX idx_impuestos_cliente_id ON impuestos(cliente_id);
CREATE INDEX idx_impuestos_estudio_id ON impuestos(estudio_id);
CREATE INDEX idx_impuestos_estado ON impuestos(estado);
CREATE INDEX idx_impuestos_fecha_vencimiento ON impuestos(fecha_vencimiento);
-- Índice compuesto para el cron job (busca pendientes vencidos todos los días)
CREATE INDEX idx_impuestos_cron ON impuestos(estado, fecha_vencimiento)
  WHERE estado = 'pendiente';
-- Anti-duplicado de la generación automática. Índice único PLENO (sin predicado):
-- así Postgres lo infiere en el ON CONFLICT del upsert (supabase-js no manda WHERE).
-- NULLS DISTINCT (default): los manuales (obligacion/periodo NULL) no colisionan,
-- un cliente puede tener muchos. OJO: acá NO va NULLS NOT DISTINCT (al revés que
-- vencimientos) justamente para que los nulls de los manuales NO choquen.
CREATE UNIQUE INDEX uq_impuestos_obligacion_periodo
  ON impuestos (cliente_id, obligacion, periodo);

-- vencimientos
CREATE INDEX idx_vencimientos_estudio_id ON vencimientos(estudio_id);

-- movimientos
-- Libro de un cliente por mes; también soporta el reemplazo de importados en la re-subida.
CREATE INDEX idx_movimientos_libro
  ON movimientos (estudio_id, cliente_id, tipo, periodo);

-- notificaciones
CREATE INDEX idx_notificaciones_impuesto_id ON notificaciones(impuesto_id);
-- Índice de lectura para el lookup del dedup (el unique real es por tipo+canal, ver arriba)
CREATE INDEX idx_notificaciones_dedup ON notificaciones(impuesto_id, tipo);

-- ============================================================
-- TRIGGER: updated_at automático en impuestos
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_impuestos_updated_at
  BEFORE UPDATE ON impuestos
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_honorarios_updated_at
  BEFORE UPDATE ON honorarios
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_honorarios_plan_updated_at
  BEFORE UPDATE ON honorarios_plan
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- FUNCIÓN: reemplazar_movimientos_importados (libro IVA)
-- ============================================================
-- Reemplazo ATÓMICO del libro IVA importado de un cliente para un período:
-- borra los movimientos importados existentes (mismo estudio/cliente/tipo/período)
-- e inserta los nuevos, todo en la misma transacción. Si el INSERT falla, el
-- DELETE se revierte: nunca queda el libro a medio reemplazar.
-- Las columnas de contexto (estudio_id, cliente_id, tipo, periodo, creado_por,
-- origen='importado') las setea la función desde sus parámetros, NO vienen en el jsonb.

CREATE OR REPLACE FUNCTION reemplazar_movimientos_importados(
  p_estudio_id uuid,
  p_cliente_id uuid,
  p_tipo       movimiento_tipo,
  p_periodo    date,
  p_creado_por uuid,
  p_registros  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_borrados   integer;
  v_insertados integer;
BEGIN
  -- 1. Borrar los importados previos de ese libro/período.
  DELETE FROM movimientos
  WHERE estudio_id = p_estudio_id
    AND cliente_id = p_cliente_id
    AND tipo       = p_tipo
    AND periodo    = p_periodo
    AND origen     = 'importado';
  GET DIAGNOSTICS v_borrados = ROW_COUNT;

  -- 2. Insertar los nuevos desde el jsonb, fijando el contexto desde los params.
  INSERT INTO movimientos (
    estudio_id, cliente_id, tipo, periodo, fecha, tipo_comprobante, letra,
    numero, contraparte, cuit_contraparte, neto, concepto_no_gravado, iva,
    acrecentamiento, total, retenciones_percepciones, op_exentas, origen, creado_por
  )
  SELECT
    p_estudio_id, p_cliente_id, p_tipo, p_periodo, r.fecha, r.tipo_comprobante,
    r.letra, r.numero, r.contraparte, r.cuit_contraparte, r.neto,
    COALESCE(r.concepto_no_gravado, 0), r.iva, COALESCE(r.acrecentamiento, 0),
    r.total, r.retenciones_percepciones, r.op_exentas, 'importado', p_creado_por
  FROM jsonb_to_recordset(p_registros) AS r(
    fecha                    date,
    tipo_comprobante         text,
    letra                    text,
    numero                   text,
    contraparte              text,
    cuit_contraparte         text,
    neto                     numeric,
    concepto_no_gravado      numeric,
    iva                      numeric,
    acrecentamiento          numeric,
    total                    numeric,
    retenciones_percepciones numeric,
    op_exentas               numeric
  );
  GET DIAGNOSTICS v_insertados = ROW_COUNT;

  -- 3. Devolver el resumen.
  RETURN jsonb_build_object('borrados', v_borrados, 'insertados', v_insertados);
END;
$$;

-- ============================================================
-- TABLA: monotributo_escala (migración 011)
-- ============================================================
-- Escala de categorías (letra + tope anual) por estudio, editada por la contadora.
-- Los clientes NO ven esta tabla; solo su posición calculada en el backend.
CREATE TABLE monotributo_escala (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id  UUID NOT NULL REFERENCES estudios(id) ON DELETE CASCADE,
  categoria   TEXT NOT NULL,
  tope_anual  DECIMAL(15, 2) NOT NULL CHECK (tope_anual > 0),
  orden       SMALLINT NOT NULL,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_monotributo_escala_estudio_cat UNIQUE (estudio_id, categoria)
);

CREATE INDEX idx_monotributo_escala_estudio ON monotributo_escala (estudio_id, orden);

-- ============================================================
-- TABLA: monotributo_facturacion (migración 011)
-- ============================================================
-- Facturación mensual del cliente monotributista, del export AFIP "Mis Comprobantes
-- Emitidos". Un import por mes; UNIQUE (cliente_id, periodo) hace idempotente el upsert.
CREATE TABLE monotributo_facturacion (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  periodo       DATE NOT NULL,
  monto         DECIMAL(15, 2) NOT NULL,
  comprobantes  INTEGER NOT NULL DEFAULT 0,
  origen        TEXT NOT NULL DEFAULT 'importado',
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_monotributo_facturacion_cliente_periodo UNIQUE (cliente_id, periodo)
);

CREATE INDEX idx_monotributo_facturacion_cliente ON monotributo_facturacion (cliente_id, periodo);
CREATE INDEX idx_monotributo_facturacion_estudio ON monotributo_facturacion (estudio_id);

CREATE TRIGGER trg_monotributo_escala_updated_at
  BEFORE UPDATE ON monotributo_escala
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_monotributo_facturacion_updated_at
  BEFORE UPDATE ON monotributo_facturacion
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SUELDOS (migración 015) — recibos de sueldo por cliente (módulo referencial).
-- La contadora los carga (período + monto + empleado + PDF opcional); el cliente
-- los ve en solo lectura. Habilitado para clientes con empleadores_sicoss / casas
-- particulares. El PDF vive en el bucket 'comprobantes' (path <estudio>/sueldos/...).
-- ============================================================
CREATE TABLE sueldos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  empleado      TEXT NOT NULL,
  periodo       DATE NOT NULL,
  monto         DECIMAL(15, 2) NOT NULL CHECK (monto >= 0),
  storage_path  TEXT,
  mime          TEXT,
  size_bytes    INTEGER,
  original_name TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sueldos_estudio_cliente_periodo ON sueldos (estudio_id, cliente_id, periodo);

CREATE TRIGGER trg_sueldos_updated_at
  BEFORE UPDATE ON sueldos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
