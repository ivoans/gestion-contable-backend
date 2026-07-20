-- ============================================================
-- MIGRACIÓN 015: sueldos (recibos de sueldo — módulo referencial)
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Seguimiento de recibos de sueldo que la contadora carga por cliente. Es
-- REFERENCIAL: el cliente lo ve en solo lectura. La sección se habilita para
-- clientes con `empleadores_sicoss` o `casas_particulares` (mismo criterio que
-- las obligaciones de SICOSS / casas particulares).
--
-- El PDF (opcional) vive en el bucket privado 'comprobantes' (el mismo que
-- comprobantes de pago y recibos), path `<estudio>/sueldos/<cliente>/...`; acá
-- solo se guarda la metadata + el path. Borrar la fila borra el objeto desde el
-- backend. Si se borra el cliente, se borran sus sueldos (CASCADE).
-- ============================================================

BEGIN;

CREATE TABLE sueldos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  empleado      TEXT NOT NULL,
  periodo       DATE NOT NULL,                      -- primer día del mes
  monto         DECIMAL(15, 2) NOT NULL CHECK (monto >= 0),
  storage_path  TEXT,                               -- NULL = sin PDF adjunto
  mime          TEXT,
  size_bytes    INTEGER,
  original_name TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Búsqueda típica: recibos de un cliente ordenados por período.
CREATE INDEX idx_sueldos_estudio_cliente_periodo ON sueldos (estudio_id, cliente_id, periodo);

CREATE TRIGGER trg_sueldos_updated_at
  BEFORE UPDATE ON sueldos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
