-- ============================================================
-- MIGRACIÓN 012: Web Push (VAPID) — dedup por canal + suscripciones
-- ============================================================
-- APLICAR A MANO EN SUPABASE (SQL editor) — no se aplica automáticamente.
-- Correr ANTES de deployar el backend que la asume.
--
-- 1) El dedup de notificaciones pasa de (target, tipo) a (target, tipo, canal):
--    el mismo aviso puede existir una vez por canal (email y push son entregas
--    independientes, cada una con su propio estado_envio/reintento). Las filas
--    existentes tienen canal='email' → recrear los índices no colisiona.
-- 2) push_subscriptions: una fila por endpoint de navegador. Un usuario puede
--    tener varias (teléfono + desktop). endpoint UNIQUE permite el upsert de
--    re-suscripción y el traspaso del endpoint si cambia el user logueado.
-- ============================================================

BEGIN;

DROP INDEX IF EXISTS uq_notif_impuesto_tipo;
DROP INDEX IF EXISTS uq_notif_honorario_tipo;

CREATE UNIQUE INDEX uq_notif_impuesto_tipo_canal
  ON notificaciones (impuesto_id, tipo, canal) WHERE impuesto_id IS NOT NULL;
CREATE UNIQUE INDEX uq_notif_honorario_tipo_canal
  ON notificaciones (honorario_id, tipo, canal) WHERE honorario_id IS NOT NULL;

ALTER TABLE notificaciones
  ADD CONSTRAINT chk_notif_canal CHECK (canal IN ('email', 'push'));

CREATE TABLE push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_push_subs_user ON push_subscriptions (user_id);

COMMIT;
