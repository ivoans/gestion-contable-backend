-- ============================================================
-- MIGRACIÓN 007: comprobantes de pago + flag por estudio
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- 1. Flag por estudio para habilitar/deshabilitar la subida de comprobantes desde el
--    panel admin. Default FALSE: la feature arranca apagada (no se usa Storage hasta
--    que el admin la prenda para un estudio).
-- 2. Tabla de METADATA de comprobantes. El archivo vive en Supabase Storage (bucket
--    privado 'comprobantes'); acá solo se guarda el path + datos chicos. UN comprobante
--    por impuesto (UNIQUE) — re-subir reemplaza. Si se borra el impuesto, se borra la
--    fila (CASCADE); el objeto en Storage se limpia desde el backend al reemplazar.
-- ============================================================

ALTER TABLE estudios
  ADD COLUMN IF NOT EXISTS comprobantes_habilitados BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS comprobantes_pago (
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

  -- Un comprobante por impuesto (re-subir reemplaza la fila vía el backend).
  CONSTRAINT uq_comprobante_por_impuesto UNIQUE (impuesto_id)
);

-- Búsquedas por impuesto (el caso típico: traer el comprobante de un impuesto).
CREATE INDEX IF NOT EXISTS idx_comprobantes_impuesto ON comprobantes_pago (impuesto_id);
