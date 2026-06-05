-- ============================================================
-- MIGRACIÓN 004: movimientos (libro IVA compras/ventas) — solo DDL
-- ============================================================
-- Cimiento del módulo de ingresos/gastos. Crea los enums nuevos y la tabla
-- `movimientos`, donde cada fila es un comprobante del libro IVA (compra o
-- venta) de un cliente para un período (mes) determinado.
--
-- Transacción única:
--   movimiento_tipo y movimiento_origen son enums NUEVOS (CREATE TYPE), que no
--   tienen la restricción del ALTER TYPE ... ADD VALUE. Por eso crear los tipos
--   y la tabla en la MISMA transacción es seguro (cf. migración 001).
--
-- Montos sin CHECK de positividad:
--   neto/iva/total/etc. pueden ser negativos (notas de crédito, ajustes), por
--   eso no se restringe el signo.
-- ============================================================

BEGIN;

-- Enums nuevos
CREATE TYPE movimiento_tipo   AS ENUM ('compra', 'venta');
CREATE TYPE movimiento_origen AS ENUM ('importado', 'manual');

-- Tabla: cada fila = un comprobante del libro IVA de un cliente en un período
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

-- Libro de un cliente por mes; también soporta el reemplazo de importados en la re-subida.
CREATE INDEX idx_movimientos_libro
  ON movimientos (estudio_id, cliente_id, tipo, periodo);

COMMIT;
