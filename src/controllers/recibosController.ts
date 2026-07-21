import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { Honorario, Recibo } from '../types';
import {
  subirComprobante,
  signedUrlComprobante,
  borrarComprobante,
  descargarComprobante,
} from '../lib/storage';
import { renderReciboPdf, formatNumeroRecibo } from '../services/reciboPdfService';
import { getDateAR } from '../utils/fechas';

const SELECT_RECIBO =
  'id, honorario_id, cliente_id, punto_venta, numero, fecha, metodo_pago, concepto, monto, storage_path, created_at';

type EstudioRecibo = {
  id: string;
  nombre: string;
  domicilio: string | null;
  cuit: string | null;
  telefono: string | null;
  email: string | null;
  condicion_iva: string | null;
  inicio_actividades: string | null;
  logo_path: string | null;
  recibo_punto_venta: number;
};

type ClienteRecibo = {
  nombre: string;
  domicilio: string | null;
  cuit: string | null;
  telefono: string | null;
  email: string | null;
  condicion_fiscal: string | null;
};

const CONDICION_LABEL: Record<string, string> = {
  monotributista: 'MONOTRIBUTO',
  responsable_inscripto: 'RESPONSABLE INSCRIPTO',
};

// Metadata + numero formateado + signed URL para el front.
async function reciboConUrl(row: Recibo): Promise<Recibo & { numero_completo: string; url: string | null }> {
  return {
    ...row,
    numero_completo: formatNumeroRecibo(row.punto_venta, row.numero),
    url: await signedUrlComprobante(row.storage_path),
  };
}

// POST /api/honorarios/:id/recibo — la CONTADORA emite el recibo de cobranza de un
// honorario PAGADO. Idempotente: si ya hay recibo, devuelve el existente (200).
// Numeración correlativa por estudio vía next_numero_recibo() (huecos posibles si el
// insert falla; aceptado).
export async function emitirRecibo(req: Request, res: Response): Promise<void> {
  const { id: honorario_id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { metodo_pago } = (req.body ?? {}) as { metodo_pago?: string };

  if (typeof metodo_pago !== 'string' || metodo_pago.trim().length === 0 || metodo_pago.length > 60) {
    res.status(400).json({ error: 'metodo_pago es requerido (máx. 60 caracteres)' });
    return;
  }

  try {
    const { data: hon, error: honError } = await supabase
      .from('honorarios')
      .select('*')
      .eq('id', honorario_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (honError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const honorario = hon as Honorario | null;
    if (!honorario || honorario.estado === 'anulado') {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }
    if (honorario.estado !== 'pagado') {
      res.status(400).json({ error: 'Solo se puede emitir el recibo de un honorario pagado' });
      return;
    }

    // Idempotencia: si ya se emitió, devolver el existente (retry del front gratis).
    const { data: existente, error: exError } = await supabase
      .from('recibos')
      .select(SELECT_RECIBO)
      .eq('honorario_id', honorario_id)
      .maybeSingle();
    if (exError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (existente) {
      res.json(await reciboConUrl(existente as Recibo));
      return;
    }

    // Identidad fiscal del estudio: sin CUIT el recibo no tiene validez ni sentido.
    const { data: est, error: estError } = await supabase
      .from('estudios')
      .select('id, nombre, domicilio, cuit, telefono, email, condicion_iva, inicio_actividades, logo_path, recibo_punto_venta')
      .eq('id', estudio_id)
      .maybeSingle();
    if (estError || !est) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const estudio = est as EstudioRecibo;
    if (!estudio.cuit) {
      res.status(400).json({ error: 'Faltan los datos fiscales del estudio (CUIT); completalos antes de emitir recibos' });
      return;
    }

    const { data: cli, error: cliError } = await supabase
      .from('users')
      .select('nombre, domicilio, cuit, telefono, email, condicion_fiscal')
      .eq('id', honorario.cliente_id)
      .maybeSingle();
    if (cliError || !cli) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const cliente = cli as ClienteRecibo;

    // Número correlativo atómico (función SQL de la migración 014).
    const { data: numData, error: numError } = await supabase.rpc('next_numero_recibo', {
      p_estudio_id: estudio_id,
    });
    if (numError || typeof numData !== 'number') {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const numero = numData;
    const punto_venta = estudio.recibo_punto_venta;

    const logo = estudio.logo_path ? await descargarComprobante(estudio.logo_path) : null;
    const fecha = getDateAR();
    const concepto = honorario.descripcion ?? 'Honorarios';

    const pdf = await renderReciboPdf({
      estudio: {
        nombre: estudio.nombre,
        domicilio: estudio.domicilio,
        telefono: estudio.telefono,
        email: estudio.email,
        condicion_iva: estudio.condicion_iva,
        cuit: estudio.cuit,
        inicio_actividades: estudio.inicio_actividades,
      },
      cliente: {
        nombre: cliente.nombre,
        domicilio: cliente.domicilio,
        cuit: cliente.cuit,
        telefono: cliente.telefono,
        email: cliente.email,
        condicion: cliente.condicion_fiscal ? CONDICION_LABEL[cliente.condicion_fiscal] ?? null : null,
      },
      numero: formatNumeroRecibo(punto_venta, numero),
      fecha,
      metodo_pago: metodo_pago.trim(),
      concepto,
      monto: Number(honorario.monto),
      logo,
    });

    const storage_path = `${estudio_id}/recibos/${honorario_id}-${numero}.pdf`;
    await subirComprobante(storage_path, pdf, 'application/pdf');

    const { data: inserted, error: insError } = await supabase
      .from('recibos')
      .insert({
        estudio_id,
        honorario_id,
        cliente_id: honorario.cliente_id,
        emitido_por: req.user!.id,
        punto_venta,
        numero,
        fecha,
        metodo_pago: metodo_pago.trim(),
        concepto,
        monto: honorario.monto,
        storage_path,
      })
      .select(SELECT_RECIBO)
      .single();

    if (insError || !inserted) {
      // Rollback best-effort del PDF; el número queda como hueco (aceptado).
      await borrarComprobante(storage_path);
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json(await reciboConUrl(inserted as Recibo));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/honorarios/:id/recibo — la CONTADORA ve el recibo emitido. 404 si no hay.
export async function reciboDeHonorario(req: Request, res: Response): Promise<void> {
  const { id: honorario_id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('recibos')
      .select(SELECT_RECIBO)
      .eq('honorario_id', honorario_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'No hay recibo emitido para este honorario' });
      return;
    }

    res.json(await reciboConUrl(data as Recibo));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/honorarios/mis-honorarios/:id/recibo — el CLIENTE descarga el recibo de un
// honorario propio. 404 si todavía no se emitió.
export async function miRecibo(req: Request, res: Response): Promise<void> {
  const { id: honorario_id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('recibos')
      .select(SELECT_RECIBO)
      .eq('honorario_id', honorario_id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'No hay recibo emitido para este honorario' });
      return;
    }

    res.json(await reciboConUrl(data as Recibo));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
