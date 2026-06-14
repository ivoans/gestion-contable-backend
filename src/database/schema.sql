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
CREATE TYPE tipo_notificacion AS ENUM ('nuevo', 'recordatorio_3dias', 'vencido');
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
-- TABLA: comprobantes_pago
-- ============================================================
-- Metadata de los comprobantes que sube el cliente. El archivo vive en Supabase
-- Storage (bucket privado 'comprobantes'); acá solo el path + datos chicos. Un
-- comprobante por impuesto (re-subir reemplaza). Ver migración 007.

CREATE TABLE comprobantes_pago (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  impuesto_id   UUID NOT NULL REFERENCES impuestos(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subido_por    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_path  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  original_name TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_comprobante_por_impuesto UNIQUE (impuesto_id)
);

CREATE INDEX idx_comprobantes_impuesto ON comprobantes_pago (impuesto_id);

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

CREATE TABLE notificaciones (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  impuesto_id  UUID NOT NULL REFERENCES impuestos(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo         tipo_notificacion NOT NULL,
  canal        VARCHAR(20) NOT NULL DEFAULT 'email',
  enviada_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

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
-- Índice compuesto para el anti-duplicado del cron
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
