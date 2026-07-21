-- ============================================================
-- MIGRACIÓN 016: monotributo_comprobantes (detalle comprobante a comprobante)
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Detalle del export AFIP "Mis Comprobantes Emitidos": una fila por comprobante
-- emitido. Complementa a monotributo_facturacion (que guarda el agregado mensual)
-- para poder mostrar una vista tipo Libro IVA (filtrable por período).
--
-- El import es idempotente por período: al re-subir un mes se borran los
-- comprobantes de ese (cliente_id, periodo) y se insertan los del archivo
-- (misma semántica de "reemplazo" que el upsert de monotributo_facturacion).
--
-- imp_total se guarda con SIGNO: las notas de crédito quedan en negativo, así el
-- total del período = SUM(imp_total) coincide con monotributo_facturacion.monto.
-- ============================================================

BEGIN;

CREATE TABLE monotributo_comprobantes (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id            UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  cliente_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  periodo               DATE NOT NULL,               -- primer día del mes (para filtrar)
  fecha                 DATE NOT NULL,               -- fecha del comprobante
  tipo                  TEXT NOT NULL,               -- "11 - Factura C", "13 - Nota de Crédito C", ...
  punto_venta           TEXT,
  numero_desde          TEXT,
  numero_hasta          TEXT,
  doc_tipo_receptor     TEXT,
  doc_nro_receptor      TEXT,
  denominacion_receptor TEXT,
  imp_total             DECIMAL(15, 2) NOT NULL,     -- con signo (NC en negativo)
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_monotributo_comprobantes_cliente_periodo
  ON monotributo_comprobantes (cliente_id, periodo);
CREATE INDEX idx_monotributo_comprobantes_estudio
  ON monotributo_comprobantes (estudio_id);

COMMIT;
