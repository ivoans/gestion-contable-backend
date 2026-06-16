-- ============================================================
-- MIGRACIÓN 006: Impuestos opcionales por cliente (solo DDL)
-- ============================================================
-- Tres obligaciones nuevas que se generan solo si el cliente las tiene
-- marcadas (flags boolean en users):
--   - convenio_multilateral: monotributista y responsable_inscripto.
--     Vence por dígito de CUIT en grupos (0,1,2) (3,4,5) (6,7) (8,9).
--   - empleadores_sicoss: solo responsable_inscripto.
--     Vence por dígito de CUIT en grupos (0,1,2,3) (4,5,6) (7,8,9).
--   - casas_particulares: solo responsable_inscripto.
--     Vence el mismo día para todos (terminacion_cuit = NULL en el calendario).
--
-- IMPORTANTE (Postgres): ALTER TYPE ... ADD VALUE no puede convivir en la
-- misma transacción con DDL que use el valor nuevo. Acá no se usa el valor
-- nuevo en ningún CHECK, pero igual se commitea aparte (mismo patrón que 001).
-- ============================================================


-- ------------------------------------------------------------
-- PASO 1: valores nuevos en el enum obligacion (transacción aparte)
-- ------------------------------------------------------------
BEGIN;
ALTER TYPE obligacion ADD VALUE IF NOT EXISTS 'convenio_multilateral';
COMMIT;

BEGIN;
ALTER TYPE obligacion ADD VALUE IF NOT EXISTS 'empleadores_sicoss';
COMMIT;

BEGIN;
ALTER TYPE obligacion ADD VALUE IF NOT EXISTS 'casas_particulares';
COMMIT;


-- ------------------------------------------------------------
-- PASO 2: flags de impuestos opcionales en users
-- ------------------------------------------------------------
BEGIN;

ALTER TABLE users
  ADD COLUMN convenio_multilateral BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN empleadores_sicoss    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN casas_particulares    BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
