-- ============================================================
-- MIGRACIÓN 010: aviso de vencido también al cliente
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Hasta ahora el aviso de "venció sin pago" iba SOLO al contador (tipo 'vencido', B2).
-- El cliente solo recibía el recordatorio previo ('recordatorio_3dias'), no el de vencido.
-- Este nuevo tipo permite mandarle al cliente una copia con texto propio
-- (sendVencidoCliente), como una notificación independiente: el dedup de notificaciones
-- es por (target, tipo), así esta fila no pisa la del contador.
--
-- NOTA: `ALTER TYPE ... ADD VALUE` no puede correr dentro de un bloque de transacción que
-- después use el valor, por eso va como sentencia suelta (sin BEGIN/COMMIT). Idempotente
-- gracias a IF NOT EXISTS.
-- ============================================================

ALTER TYPE tipo_notificacion ADD VALUE IF NOT EXISTS 'vencido_cliente';
