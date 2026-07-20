-- ============================================================
-- MIGRACIÓN 014: honorarios sueltos + recibos de cobranza (E8 + E7)
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
--  1. honorarios.periodo pasa a nullable: los honorarios SUELTOS (sin plan) van con
--     periodo NULL + descripcion. El UNIQUE (cliente_id, periodo) no aplica a NULL,
--     así que el dedup de la generación mensual queda intacto y los sueltos no chocan
--     con el abono del mes.
--  2. estudios: identidad fiscal para el encabezado del recibo (réplica del 398.pdf
--     de Alegra) + contador de numeración correlativa por estudio.
--  3. users.domicilio: el recibo muestra el domicilio del cliente.
--  4. recibos: un recibo de cobranza por honorario cobrado (PDF en Storage).
--  5. next_numero_recibo(): numeración atómica (UPDATE ... RETURNING). Si el insert
--     posterior falla queda un hueco en la numeración; aceptado.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) honorarios sueltos: periodo nullable
-- ------------------------------------------------------------
ALTER TABLE honorarios ALTER COLUMN periodo DROP NOT NULL;

-- ------------------------------------------------------------
-- 2) estudios: identidad fiscal + numeración de recibos
-- ------------------------------------------------------------
ALTER TABLE estudios
  ADD COLUMN domicilio              TEXT,
  ADD COLUMN cuit                   VARCHAR(13),
  ADD COLUMN telefono               VARCHAR(30),
  ADD COLUMN email                  VARCHAR(255),
  ADD COLUMN condicion_iva          TEXT,          -- texto libre, ej. 'MONOTRIBUTO'
  ADD COLUMN inicio_actividades     DATE,
  ADD COLUMN logo_path              TEXT,          -- objeto en el bucket 'comprobantes'
  ADD COLUMN recibo_punto_venta     SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN recibo_proximo_numero  INTEGER  NOT NULL DEFAULT 1;

-- ------------------------------------------------------------
-- 3) users: domicilio del cliente (bloque de datos del recibo)
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN domicilio TEXT;

-- ------------------------------------------------------------
-- 4) TABLA: recibos (recibo de cobranza emitido al cobrar un honorario)
-- ------------------------------------------------------------
CREATE TABLE recibos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  estudio_id    UUID NOT NULL REFERENCES estudios(id) ON DELETE RESTRICT,
  honorario_id  UUID NOT NULL REFERENCES honorarios(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  emitido_por   UUID REFERENCES users(id) ON DELETE RESTRICT,
  punto_venta   SMALLINT NOT NULL,
  numero        INTEGER NOT NULL,
  fecha         DATE NOT NULL,
  metodo_pago   TEXT NOT NULL,
  concepto      TEXT NOT NULL,
  monto         DECIMAL(12, 2) NOT NULL,
  storage_path  TEXT NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Un recibo por honorario; revertir el cobro borra el recibo.
  CONSTRAINT uq_recibo_por_honorario UNIQUE (honorario_id),
  -- La numeración es correlativa dentro del estudio (por punto de venta).
  CONSTRAINT uq_recibo_numero UNIQUE (estudio_id, punto_venta, numero)
);

CREATE INDEX idx_recibos_estudio ON recibos (estudio_id);
CREATE INDEX idx_recibos_cliente ON recibos (cliente_id);

-- ------------------------------------------------------------
-- 5) Numeración atómica por estudio
-- ------------------------------------------------------------
CREATE FUNCTION next_numero_recibo(p_estudio_id UUID) RETURNS INTEGER
LANGUAGE sql AS $$
  UPDATE estudios
  SET recibo_proximo_numero = recibo_proximo_numero + 1
  WHERE id = p_estudio_id
  RETURNING recibo_proximo_numero - 1;
$$;

-- ------------------------------------------------------------
-- Seed: datos reales del estudio (tomados del 398.pdf de Alegra).
-- El WHERE por nombre evita pisar otros estudios si algún día hay más de uno.
-- Verificar después de aplicar: SELECT nombre, cuit FROM estudios;
-- ------------------------------------------------------------
UPDATE estudios SET
  domicilio          = 'Garibaldi N° 639 - General Acha',
  cuit               = '27399325957',
  telefono           = '+542954679789',
  email              = 'estudiocontablestvm@gmail.com',
  condicion_iva      = 'MONOTRIBUTO',
  inicio_actividades = '2026-01-01'
WHERE nombre ILIKE '%estudio contable st%';

COMMIT;
