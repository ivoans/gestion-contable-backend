import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { supabase } from '../lib/supabase';
import {
  subirComprobante,
  signedUrlComprobante,
  borrarComprobante,
} from '../lib/storage';

// Mimes que aceptamos al subir. Las imágenes se recomprimen a JPEG; el PDF va tal cual.
const MIMES_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIME_PDF = 'application/pdf';

// Compresión de imágenes: máx 1600px lado mayor, JPEG 72%. Baja una foto de celular
// de varios MB a ~150-300KB, que es lo que hace viable el Storage gratis.
const MAX_LADO = 1600;
const JPEG_QUALITY = 72;

interface ComprobanteRow {
  id: string;
  impuesto_id?: string | null;
  honorario_id?: string | null;
  storage_path: string;
  mime: string;
  size_bytes: number;
  original_name: string | null;
  created_at: string;
}

// ¿El estudio tiene habilitada la subida de comprobantes? (flag que prende el admin).
async function comprobantesHabilitados(estudio_id: string | null): Promise<boolean> {
  const { data, error } = await supabase
    .from('estudios')
    .select('comprobantes_habilitados')
    .eq('id', estudio_id)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { comprobantes_habilitados: boolean }).comprobantes_habilitados === true;
}

// Devuelve el comprobante (metadata + signed URL) o null si no hay/falla.
async function comprobanteConUrl(
  row: ComprobanteRow | null,
): Promise<(ComprobanteRow & { url: string | null }) | null> {
  if (!row) return null;
  const url = await signedUrlComprobante(row.storage_path);
  return { ...row, url };
}

const SELECT_COMPROBANTE =
  'id, impuesto_id, storage_path, mime, size_bytes, original_name, created_at';

const SELECT_COMPROBANTE_HON =
  'id, honorario_id, storage_path, mime, size_bytes, original_name, created_at';

// Procesa el archivo subido (imagen → JPEG comprimido; PDF → tal cual). Devuelve null
// si el mime no es aceptado.
async function procesarArchivo(
  file: Express.Multer.File,
): Promise<{ buffer: Buffer; mime: string; ext: string } | null> {
  const mimeOriginal = file.mimetype;
  if (MIMES_IMAGEN.has(mimeOriginal)) {
    const buffer = await sharp(file.buffer)
      .rotate()
      .resize({ width: MAX_LADO, height: MAX_LADO, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { buffer, mime: 'image/jpeg', ext: 'jpg' };
  }
  if (mimeOriginal === MIME_PDF) {
    return { buffer: file.buffer, mime: MIME_PDF, ext: 'pdf' };
  }
  return null;
}

// POST /api/impuestos/mis-impuestos/:id/comprobante — el CLIENTE adjunta el comprobante
// de pago de un impuesto PROPIO. Gateado por el flag del estudio. Un comprobante por
// impuesto: re-subir reemplaza el anterior (borra el objeto viejo en Storage).
export async function subirMiComprobante(req: Request, res: Response): Promise<void> {
  const { id: impuesto_id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  if (!(await comprobantesHabilitados(estudio_id))) {
    res.status(403).json({ error: 'La subida de comprobantes no está habilitada' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'El archivo es requerido en el campo "archivo"' });
    return;
  }

  const mimeOriginal = req.file.mimetype;
  const esImagen = MIMES_IMAGEN.has(mimeOriginal);
  const esPdf = mimeOriginal === MIME_PDF;
  if (!esImagen && !esPdf) {
    res.status(400).json({ error: 'Solo se aceptan imágenes (jpg, png, webp) o PDF' });
    return;
  }

  try {
    // El impuesto debe existir, ser del cliente y del estudio, y no ser borrador.
    const { data: imp, error: impError } = await supabase
      .from('impuestos')
      .select('id, estado')
      .eq('id', impuesto_id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (impError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const impuesto = imp as { id: string; estado: string } | null;
    if (!impuesto || impuesto.estado === 'borrador') {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    // Procesar el archivo: imágenes → JPEG comprimido; PDF → tal cual.
    let buffer: Buffer;
    let mime: string;
    let ext: string;
    if (esImagen) {
      buffer = await sharp(req.file.buffer)
        .rotate() // respeta la orientación EXIF de las fotos de celular
        .resize({ width: MAX_LADO, height: MAX_LADO, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      mime = 'image/jpeg';
      ext = 'jpg';
    } else {
      buffer = req.file.buffer;
      mime = MIME_PDF;
      ext = 'pdf';
    }

    // Si ya había un comprobante para este impuesto, borrar su objeto en Storage antes
    // de reemplazarlo (la fila se reemplaza por el UNIQUE de impuesto_id).
    const { data: prev } = await supabase
      .from('comprobantes_pago')
      .select('id, storage_path')
      .eq('impuesto_id', impuesto_id)
      .maybeSingle();
    const previo = prev as { id: string; storage_path: string } | null;
    if (previo) {
      await borrarComprobante(previo.storage_path);
      await supabase.from('comprobantes_pago').delete().eq('id', previo.id);
    }

    const storage_path = `${estudio_id}/${impuesto_id}/${randomUUID()}.${ext}`;
    await subirComprobante(storage_path, buffer, mime);

    const { data, error } = await supabase
      .from('comprobantes_pago')
      .insert({
        estudio_id,
        impuesto_id,
        cliente_id,
        subido_por: cliente_id,
        storage_path,
        mime,
        size_bytes: buffer.length,
        original_name: req.file.originalname ?? null,
      })
      .select(SELECT_COMPROBANTE)
      .single();

    if (error || !data) {
      // Rollback best-effort del objeto subido si la metadata no entró.
      await borrarComprobante(storage_path);
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const conUrl = await comprobanteConUrl(data as ComprobanteRow);
    res.status(201).json(conUrl);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/impuestos/mis-impuestos/:id/comprobante — el CLIENTE ve el comprobante de un
// impuesto propio (metadata + signed URL). 404 si no hay.
export async function miComprobante(req: Request, res: Response): Promise<void> {
  const { id: impuesto_id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('comprobantes_pago')
      .select(SELECT_COMPROBANTE)
      .eq('impuesto_id', impuesto_id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'No hay comprobante para este impuesto' });
      return;
    }

    res.json(await comprobanteConUrl(data as ComprobanteRow));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── COMPROBANTES DE HONORARIOS ───────────────────────────────────────────────

// POST /api/honorarios/mis-honorarios/:id/comprobante — el CLIENTE adjunta el comprobante
// de pago de un honorario PROPIO. Gateado por el flag del estudio. Un comprobante por
// honorario: re-subir reemplaza.
export async function subirMiComprobanteHonorario(req: Request, res: Response): Promise<void> {
  const { id: honorario_id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  if (!(await comprobantesHabilitados(estudio_id))) {
    res.status(403).json({ error: 'La subida de comprobantes no está habilitada' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'El archivo es requerido en el campo "archivo"' });
    return;
  }

  const procesado = await procesarArchivo(req.file).catch(() => null);
  if (!procesado) {
    res.status(400).json({ error: 'Solo se aceptan imágenes (jpg, png, webp) o PDF' });
    return;
  }

  try {
    // El honorario debe existir, ser del cliente y del estudio, y no estar anulado.
    const { data: hon, error: honError } = await supabase
      .from('honorarios')
      .select('id, estado')
      .eq('id', honorario_id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (honError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const honorario = hon as { id: string; estado: string } | null;
    if (!honorario || honorario.estado === 'anulado') {
      res.status(404).json({ error: 'Honorario no encontrado' });
      return;
    }

    // Reemplazar el comprobante previo (objeto en Storage + fila) si existía.
    const { data: prev } = await supabase
      .from('comprobantes_pago')
      .select('id, storage_path')
      .eq('honorario_id', honorario_id)
      .maybeSingle();
    const previo = prev as { id: string; storage_path: string } | null;
    if (previo) {
      await borrarComprobante(previo.storage_path);
      await supabase.from('comprobantes_pago').delete().eq('id', previo.id);
    }

    const storage_path = `${estudio_id}/honorarios/${honorario_id}/${randomUUID()}.${procesado.ext}`;
    await subirComprobante(storage_path, procesado.buffer, procesado.mime);

    const { data, error } = await supabase
      .from('comprobantes_pago')
      .insert({
        estudio_id,
        honorario_id,
        cliente_id,
        subido_por: cliente_id,
        storage_path,
        mime: procesado.mime,
        size_bytes: procesado.buffer.length,
        original_name: req.file.originalname ?? null,
      })
      .select(SELECT_COMPROBANTE_HON)
      .single();

    if (error || !data) {
      await borrarComprobante(storage_path);
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json(await comprobanteConUrl(data as ComprobanteRow));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/honorarios/mis-honorarios/:id/comprobante — el CLIENTE ve el comprobante de un
// honorario propio. 404 si no hay.
export async function miComprobanteHonorario(req: Request, res: Response): Promise<void> {
  const { id: honorario_id } = req.params;
  const cliente_id = req.user!.id;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('comprobantes_pago')
      .select(SELECT_COMPROBANTE_HON)
      .eq('honorario_id', honorario_id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'No hay comprobante para este honorario' });
      return;
    }

    res.json(await comprobanteConUrl(data as ComprobanteRow));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/honorarios/:id/comprobante — la CONTADORA ve el comprobante de un honorario de
// su estudio. 404 si no hay.
export async function comprobanteDeHonorario(req: Request, res: Response): Promise<void> {
  const { id: honorario_id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('comprobantes_pago')
      .select(SELECT_COMPROBANTE_HON)
      .eq('honorario_id', honorario_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'No hay comprobante para este honorario' });
      return;
    }

    res.json(await comprobanteConUrl(data as ComprobanteRow));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/impuestos/:id/comprobante — la CONTADORA ve el comprobante de un impuesto de
// su estudio (metadata + signed URL). 404 si no hay.
export async function comprobanteDeImpuesto(req: Request, res: Response): Promise<void> {
  const { id: impuesto_id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('comprobantes_pago')
      .select(SELECT_COMPROBANTE)
      .eq('impuesto_id', impuesto_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'No hay comprobante para este impuesto' });
      return;
    }

    res.json(await comprobanteConUrl(data as ComprobanteRow));
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
