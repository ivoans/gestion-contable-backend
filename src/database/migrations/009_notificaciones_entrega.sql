-- ============================================================
-- MIGRACIÓN 009: entrega confiable de notificaciones
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Arregla B2/B3 de AUDIT.md desacoplando "hay que avisar" de "se mandó":
--
--  - estado_envio: cada notificación lleva su estado de entrega
--    ('pendiente' | 'enviada' | 'fallida'). El cron reintenta las que no quedaron
--    'enviada' en vez de perderlas para siempre. enviada_at deja de ser obligatorio
--    (solo se setea cuando se entrega de verdad).
--  - intentos / ultimo_error: observabilidad de reintentos.
--  - honorario_id: la tabla se generaliza para colgar de un impuesto O de un honorario
--    (exactamente uno), así el mismo mecanismo sirve para las notificaciones de
--    honorarios cuando se cablee Web Push (F3). Hoy no se usa para honorarios.
--  - índices únicos parciales (target, tipo): garantizan UNA fila por aviso, para que
--    los reintentos actualicen esa fila y no se dupliquen.
--
-- NOTA: si en prod hubiera filas duplicadas (mismo impuesto_id + tipo), los CREATE UNIQUE
-- INDEX fallarán; deduplicar antes. El código viejo evitaba duplicados, así que no debería
-- pasar.
-- ============================================================

BEGIN;

-- enviada_at pasa a opcional: una fila 'pendiente' todavía no se envió.
ALTER TABLE notificaciones ALTER COLUMN enviada_at DROP NOT NULL;
ALTER TABLE notificaciones ALTER COLUMN enviada_at DROP DEFAULT;

-- Estado de entrega. Default 'pendiente' para filas nuevas...
ALTER TABLE notificaciones
  ADD COLUMN estado_envio VARCHAR(20) NOT NULL DEFAULT 'pendiente'
    CHECK (estado_envio IN ('pendiente', 'enviada', 'fallida'));

-- ...pero las filas históricas ya estaban enviadas (tenían enviada_at).
UPDATE notificaciones SET estado_envio = 'enviada' WHERE enviada_at IS NOT NULL;

ALTER TABLE notificaciones ADD COLUMN intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notificaciones ADD COLUMN ultimo_error TEXT;

-- Generalizar el target: impuesto O honorario, exactamente uno.
ALTER TABLE notificaciones ALTER COLUMN impuesto_id DROP NOT NULL;
ALTER TABLE notificaciones
  ADD COLUMN honorario_id UUID REFERENCES honorarios(id) ON DELETE CASCADE;
ALTER TABLE notificaciones
  ADD CONSTRAINT chk_notif_target
    CHECK ((impuesto_id IS NOT NULL) <> (honorario_id IS NOT NULL));

-- Una sola notificación por (target, tipo): los reintentos updatean esa fila.
CREATE UNIQUE INDEX uq_notif_impuesto_tipo
  ON notificaciones (impuesto_id, tipo) WHERE impuesto_id IS NOT NULL;
CREATE UNIQUE INDEX uq_notif_honorario_tipo
  ON notificaciones (honorario_id, tipo) WHERE honorario_id IS NOT NULL;

-- Para barrer rápido lo que falta entregar.
CREATE INDEX idx_notif_pendientes ON notificaciones (estado_envio)
  WHERE estado_envio <> 'enviada';

COMMIT;
