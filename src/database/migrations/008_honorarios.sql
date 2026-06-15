-- ============================================================
-- MIGRACIÓN 008: honorarios (abono mensual del cliente al estudio)
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Modelo: el honorario es lo que el cliente le debe al estudio. Es el gemelo de
-- `impuestos`, pero la deuda es con el estudio (no con AFIP).
--
--  1. honorarios_plan: el abono fijo configurado por cliente (un plan por cliente).
--     La contadora edita `monto` acá; afecta los meses que se generen de ahí en más.
--  2. honorarios: la instancia mensual generada a partir del plan (o creada a mano).
--     UNIQUE (cliente_id, periodo) para que la generación sea idempotente.
--  3. comprobantes_pago: se generaliza para poder colgar de un impuesto O de un
--     honorario (exactamente uno de los dos).
-- ============================================================

BEGIN;

-- Estado del honorario. 'anulado' = la contadora lo cancela (p.ej. el cliente se dio de baja).
CREATE TYPE estado_honorario AS ENUM ('pendiente', 'vencido', 'pagado', 'anulado');

-- ------------------------------------------------------------
-- TABLA: honorarios_plan (abono recurrente por cliente)
-- ------------------------------------------------------------
CREATE TABLE honorarios_plan (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monto             DECIMAL(12, 2) NOT NULL CHECK (monto > 0),
  -- Día del mes del vencimiento. Tope 28 para que exista en todos los meses.
  dia_vencimiento   SMALLINT NOT NULL DEFAULT 10 CHECK (dia_vencimiento BETWEEN 1 AND 28),
  activo            BOOLEAN NOT NULL DEFAULT true,
  vigente_desde     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Un solo plan por cliente (se edita/activa/desactiva esa fila).
  CONSTRAINT uq_honorarios_plan_cliente UNIQUE (cliente_id)
);

CREATE INDEX idx_honorarios_plan_estudio ON honorarios_plan (estudio_id);

-- ------------------------------------------------------------
-- TABLA: honorarios (instancia mensual)
-- ------------------------------------------------------------
CREATE TABLE honorarios (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creado_por        UUID REFERENCES users(id) ON DELETE RESTRICT,  -- NULL = generado por cron
  periodo           DATE NOT NULL,            -- primer día del mes
  monto             DECIMAL(12, 2) NOT NULL CHECK (monto > 0),
  fecha_vencimiento DATE NOT NULL,
  descripcion       TEXT,
  estado            estado_honorario NOT NULL DEFAULT 'pendiente',
  pagado_at         TIMESTAMP WITH TIME ZONE,
  pagado_por        UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Un honorario por cliente por mes (anti-duplicado de la generación).
  CONSTRAINT uq_honorarios_cliente_periodo UNIQUE (cliente_id, periodo),

  -- Si está pagado, pagado_at y pagado_por completos; si no, ambos null.
  CONSTRAINT chk_honorario_pagado_completo CHECK (
    (estado = 'pagado' AND pagado_at IS NOT NULL AND pagado_por IS NOT NULL) OR
    (estado <> 'pagado' AND pagado_at IS NULL AND pagado_por IS NULL)
  )
);

CREATE INDEX idx_honorarios_cliente ON honorarios (cliente_id);
CREATE INDEX idx_honorarios_estudio ON honorarios (estudio_id);
CREATE INDEX idx_honorarios_estado ON honorarios (estado);
-- Cron de vencidos: pendientes con fecha pasada.
CREATE INDEX idx_honorarios_cron ON honorarios (estado, fecha_vencimiento)
  WHERE estado = 'pendiente';

-- updated_at automático (reusa la función set_updated_at() del schema base).
CREATE TRIGGER trg_honorarios_updated_at
  BEFORE UPDATE ON honorarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_honorarios_plan_updated_at
  BEFORE UPDATE ON honorarios_plan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- comprobantes_pago: generalizar a impuesto O honorario
-- ------------------------------------------------------------
ALTER TABLE comprobantes_pago ALTER COLUMN impuesto_id DROP NOT NULL;

ALTER TABLE comprobantes_pago
  ADD COLUMN honorario_id UUID REFERENCES honorarios(id) ON DELETE CASCADE;

-- El UNIQUE viejo (constraint) se reemplaza por índices únicos parciales por tipo.
ALTER TABLE comprobantes_pago DROP CONSTRAINT IF EXISTS uq_comprobante_por_impuesto;

-- Exactamente uno de los dos targets.
ALTER TABLE comprobantes_pago
  ADD CONSTRAINT chk_comprobante_target CHECK (
    (impuesto_id IS NOT NULL AND honorario_id IS NULL) OR
    (impuesto_id IS NULL AND honorario_id IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_comprobante_por_impuesto
  ON comprobantes_pago (impuesto_id) WHERE impuesto_id IS NOT NULL;
CREATE UNIQUE INDEX uq_comprobante_por_honorario
  ON comprobantes_pago (honorario_id) WHERE honorario_id IS NOT NULL;
CREATE INDEX idx_comprobantes_honorario ON comprobantes_pago (honorario_id);

COMMIT;
