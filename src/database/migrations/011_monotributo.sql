-- ============================================================
-- MIGRACIÓN 011: monotributo (escala por estudio + facturación mensual del cliente)
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Dos tablas:
--  1. monotributo_escala: la escala de categorías (letra + tope anual de facturación)
--     que edita la contadora, por estudio (como el calendario de vencimientos).
--     Los clientes NO ven esta tabla; solo su posición calculada en el backend.
--  2. monotributo_facturacion: la facturación mensual del cliente monotributista,
--     cargada desde el export "Mis Comprobantes Emitidos" de AFIP (un import por mes).
--     UNIQUE (cliente_id, periodo) para que re-subir un mes lo reemplace (idempotente).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- TABLA: monotributo_escala (config por estudio)
-- ------------------------------------------------------------
CREATE TABLE monotributo_escala (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id  UUID NOT NULL REFERENCES estudios(id) ON DELETE CASCADE,
  categoria   TEXT NOT NULL,                       -- letra (A, B, C, ...)
  tope_anual  DECIMAL(15, 2) NOT NULL CHECK (tope_anual > 0),
  orden       SMALLINT NOT NULL,                   -- para ordenar la escala de menor a mayor
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Una fila por letra por estudio.
  CONSTRAINT uq_monotributo_escala_estudio_cat UNIQUE (estudio_id, categoria)
);

CREATE INDEX idx_monotributo_escala_estudio ON monotributo_escala (estudio_id, orden);

-- ------------------------------------------------------------
-- TABLA: monotributo_facturacion (ventas mensuales del cliente)
-- ------------------------------------------------------------
CREATE TABLE monotributo_facturacion (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  periodo       DATE NOT NULL,                     -- primer día del mes
  monto         DECIMAL(15, 2) NOT NULL,           -- suma de Imp. Total del período
  comprobantes  INTEGER NOT NULL DEFAULT 0,        -- cantidad de comprobantes del período
  origen        TEXT NOT NULL DEFAULT 'importado',
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Un registro por cliente por mes (anti-duplicado; re-subir reemplaza vía upsert).
  CONSTRAINT uq_monotributo_facturacion_cliente_periodo UNIQUE (cliente_id, periodo)
);

CREATE INDEX idx_monotributo_facturacion_cliente ON monotributo_facturacion (cliente_id, periodo);
CREATE INDEX idx_monotributo_facturacion_estudio ON monotributo_facturacion (estudio_id);

-- updated_at automático (reusa set_updated_at() del schema base).
CREATE TRIGGER trg_monotributo_escala_updated_at
  BEFORE UPDATE ON monotributo_escala
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_monotributo_facturacion_updated_at
  BEFORE UPDATE ON monotributo_facturacion
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
