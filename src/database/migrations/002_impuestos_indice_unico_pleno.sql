-- ============================================================
-- MIGRACIÓN 002: índice anti-duplicado de impuestos → único PLENO
-- ============================================================
-- Por qué:
--   El índice parcial uq_impuestos_obligacion_periodo (creado en la 001) tenía
--   predicado `WHERE obligacion IS NOT NULL`. supabase-js NO manda ese predicado
--   en el onConflict del upsert, así que Postgres no puede inferir el índice
--   parcial como árbitro del ON CONFLICT → la generación automática fallaría con
--   "no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Fix:
--   Reemplazar por un índice único PLENO, sin predicado, sobre las mismas
--   columnas. Postgres lo infiere bien en el ON CONFLICT.
--
-- Por qué NO afecta a los impuestos manuales:
--   Los manuales tienen obligacion y periodo en NULL. Con NULLS DISTINCT (el
--   default, a diferencia de vencimientos que usa NULLS NOT DISTINCT), cualquier
--   fila con un NULL en las columnas indexadas se considera distinta de las demás
--   → un cliente puede seguir teniendo muchos impuestos manuales sin colisionar.
--
-- Compatibilidad con datos actuales:
--   - Filas generadas (obligacion NOT NULL): ya eran únicas por el índice parcial;
--     las tres columnas son no-nulas, el índice pleno enforza lo mismo → no rompe.
--   - Filas manuales (obligacion/periodo NULL): bajo NULLS DISTINCT no violan el
--     índice pleno.
-- ============================================================

BEGIN;

-- Fuera el índice parcial.
DROP INDEX IF EXISTS uq_impuestos_obligacion_periodo;

-- Índice único pleno (NULLS DISTINCT por default): infiere en el ON CONFLICT del
-- upsert de la generación y deja libres a los manuales (obligacion/periodo NULL).
CREATE UNIQUE INDEX uq_impuestos_obligacion_periodo
  ON impuestos (cliente_id, obligacion, periodo);

COMMIT;
