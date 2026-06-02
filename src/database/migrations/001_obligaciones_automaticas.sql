-- ============================================================
-- MIGRACIÓN 001: Obligaciones impositivas automáticas (solo DDL)
-- ============================================================
-- Compatible con datos existentes:
--   - users: columnas nuevas NULLABLE (admin/contador/clientes sin clasificar = NULL).
--   - impuestos: las filas actuales tienen monto válido (> 0) y estado <> 'borrador',
--     así que pasan la constraint nueva chk_monto_por_estado.
--
-- IMPORTANTE (Postgres): no se puede agregar un valor a un enum con
-- ALTER TYPE ... ADD VALUE y usar ese valor (p.ej. en un CHECK) dentro de la
-- MISMA transacción ("unsafe use of new value of enum type"). Por eso el alta
-- del valor 'borrador' va en su propia transacción y se commitea ANTES de usarlo.
-- ============================================================


-- ------------------------------------------------------------
-- PASO 1: valor nuevo en enum existente (transacción aparte, debe commitear primero)
-- ------------------------------------------------------------
BEGIN;
ALTER TYPE estado_impuesto ADD VALUE IF NOT EXISTS 'borrador';
COMMIT;


-- ------------------------------------------------------------
-- PASO 2: resto del DDL (enums nuevos, columnas, constraints, tabla, índices)
-- ------------------------------------------------------------
BEGIN;

-- Enums nuevos (CREATE TYPE no tiene la restricción de transacción del ADD VALUE)
CREATE TYPE condicion_fiscal AS ENUM ('monotributista', 'responsable_inscripto');
CREATE TYPE obligacion       AS ENUM ('monotributo', 'iva', 'autonomos', 'ingresos_brutos');

-- users: clasificación fiscal del cliente
ALTER TABLE users
  ADD COLUMN condicion_fiscal condicion_fiscal,   -- NULL: admin/contador o cliente sin clasificar
  ADD COLUMN categoria        VARCHAR;            -- letra del monotributo, solo referencia

-- impuestos: monto pasa a NULLABLE; constraint según estado
ALTER TABLE impuestos
  DROP CONSTRAINT IF EXISTS impuestos_monto_check;  -- el CHECK (monto > 0) inline
ALTER TABLE impuestos
  ALTER COLUMN monto DROP NOT NULL;

-- Si NO es borrador -> monto obligatorio y > 0. Si es borrador -> monto puede ser NULL.
ALTER TABLE impuestos
  ADD CONSTRAINT chk_monto_por_estado CHECK (
    (estado <> 'borrador' AND monto IS NOT NULL AND monto > 0)
    OR estado = 'borrador'
  );

-- impuestos: campos para la generación automática (NULL en los cargados a mano)
ALTER TABLE impuestos
  ADD COLUMN vep        VARCHAR,
  ADD COLUMN obligacion obligacion,   -- NULL = impuesto manual
  ADD COLUMN periodo    DATE;         -- mes declarado; NULL = manual

-- Anti-duplicado de la generación, sin afectar a los manuales (obligacion NULL)
CREATE UNIQUE INDEX uq_impuestos_obligacion_periodo
  ON impuestos (cliente_id, obligacion, periodo)
  WHERE obligacion IS NOT NULL;

-- Calendario de vencimientos que carga la contadora
CREATE TABLE vencimientos (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id        UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  obligacion        obligacion NOT NULL,
  terminacion_cuit  SMALLINT CHECK (terminacion_cuit BETWEEN 0 AND 9),  -- NULL = "todos"
  anio              INT NOT NULL,
  mes               SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  fecha_vencimiento DATE NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- NULLS NOT DISTINCT (PG15+): dos NULL de terminacion_cuit se consideran iguales,
  -- así la fila "todos" no se puede duplicar para un mismo (estudio, obligacion, anio, mes).
  CONSTRAINT uq_vencimientos UNIQUE NULLS NOT DISTINCT
    (estudio_id, obligacion, terminacion_cuit, anio, mes)
);

CREATE INDEX idx_vencimientos_estudio_id ON vencimientos(estudio_id);

COMMIT;
