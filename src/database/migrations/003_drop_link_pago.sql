-- ============================================================
-- MIGRACIÓN 003: drop de la columna link_pago en impuestos
-- ============================================================
-- Por qué:
--   El link de pago lo reemplaza el VEP (columna `vep`, ya existente). El campo
--   `link_pago` quedó sin uso: el backend ya no lo acepta, valida, selecciona ni
--   lo renderiza en el email de nuevo impuesto.
--
-- Orden de aplicación:
--   Correr DESPUÉS de deployar el código que dejó de usar la columna, así no queda
--   código viejo seleccionando una columna inexistente.
--
-- Compatibilidad:
--   DROP COLUMN IF EXISTS → idempotente. No hay constraints ni índices sobre
--   link_pago, así que el drop no arrastra dependencias.
-- ============================================================

BEGIN;

ALTER TABLE impuestos DROP COLUMN IF EXISTS link_pago;

COMMIT;
