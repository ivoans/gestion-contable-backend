-- ============================================================
-- MIGRACIÓN 005: función reemplazar_movimientos_importados
-- ============================================================
-- APLICAR A MANO EN SUPABASE — no se aplica automáticamente.
--
-- Reemplazo ATÓMICO del libro IVA importado de un cliente para un período:
-- borra los movimientos importados existentes (mismo estudio/cliente/tipo/período)
-- e inserta los nuevos, todo en la misma transacción (la ejecución de una función
-- plpgsql es atómica dentro de su transacción). Si el INSERT falla, el DELETE se
-- revierte: nunca queda el libro a medio reemplazar.
--
-- Los registros llegan como jsonb (array de objetos) desde el endpoint. Las
-- columnas de contexto (estudio_id, cliente_id, tipo, periodo, creado_por,
-- origen='importado') las setea la función desde sus parámetros, NO vienen en
-- el jsonb.
-- ============================================================

CREATE OR REPLACE FUNCTION reemplazar_movimientos_importados(
  p_estudio_id uuid,
  p_cliente_id uuid,
  p_tipo       movimiento_tipo,
  p_periodo    date,
  p_creado_por uuid,
  p_registros  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_borrados   integer;
  v_insertados integer;
BEGIN
  -- 1. Borrar los importados previos de ese libro/período.
  DELETE FROM movimientos
  WHERE estudio_id = p_estudio_id
    AND cliente_id = p_cliente_id
    AND tipo       = p_tipo
    AND periodo    = p_periodo
    AND origen     = 'importado';
  GET DIAGNOSTICS v_borrados = ROW_COUNT;

  -- 2. Insertar los nuevos desde el jsonb, fijando el contexto desde los params.
  INSERT INTO movimientos (
    estudio_id, cliente_id, tipo, periodo, fecha, tipo_comprobante, letra,
    numero, contraparte, cuit_contraparte, neto, concepto_no_gravado, iva,
    acrecentamiento, total, retenciones_percepciones, op_exentas, origen, creado_por
  )
  SELECT
    p_estudio_id, p_cliente_id, p_tipo, p_periodo, r.fecha, r.tipo_comprobante,
    r.letra, r.numero, r.contraparte, r.cuit_contraparte, r.neto,
    COALESCE(r.concepto_no_gravado, 0), r.iva, COALESCE(r.acrecentamiento, 0),
    r.total, r.retenciones_percepciones, r.op_exentas, 'importado', p_creado_por
  FROM jsonb_to_recordset(p_registros) AS r(
    fecha                    date,
    tipo_comprobante         text,
    letra                    text,
    numero                   text,
    contraparte              text,
    cuit_contraparte         text,
    neto                     numeric,
    concepto_no_gravado      numeric,
    iva                      numeric,
    acrecentamiento          numeric,
    total                    numeric,
    retenciones_percepciones numeric,
    op_exentas               numeric
  );
  GET DIAGNOSTICS v_insertados = ROW_COUNT;

  -- 3. Devolver el resumen.
  RETURN jsonb_build_object('borrados', v_borrados, 'insertados', v_insertados);
END;
$$;
