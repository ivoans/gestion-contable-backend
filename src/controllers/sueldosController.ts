import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabase';
import { UUID_REGEX } from '../utils/validators';
import { procesarArchivo } from '../utils/archivoUpload';
import { subirComprobante, signedUrlComprobante, borrarComprobante } from '../lib/storage';

// Módulo SUELDOS (E3, Fase 4): la contadora carga recibos de sueldo por cliente
// (período + monto + empleado + PDF opcional, todo en el mismo request); el cliente
// los ve en solo lectura. Referencial, sin flujo de pago. El PDF va al bucket
// 'comprobantes' (path `<estudio>/sueldos/<cliente>/...`); acá solo la metadata.

const SELECT_SUELDO =
  'id, estudio_id, cliente_id, empleado, periodo, monto, storage_path, mime, size_bytes, original_name, created_at, updated_at';

// YYYY-MM o YYYY-MM-DD → YYYY-MM-01 (primer día del mes). null si no parsea.
function normalizarPeriodo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!m) return null;
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12 || anio < 2000 || anio > 2100) return null;
  return `${m[1]}-${m[2]}-01`;
}

// Normaliza el monto a número >= 0 con 2 decimales. null si no es válido.
function parseMonto(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

type ChequeoCliente = { ok: true } | { ok: false; status: number; error: string };

// El cliente debe existir, ser cliente del estudio y tener habilitado el módulo:
// `empleadores_sicoss` o `casas_particulares` (mismo criterio que la nav del cliente).
async function clienteHabilitado(
  estudio_id: string | null,
  cliente_id: string,
): Promise<ChequeoCliente> {
  const { data, error } = await supabase
    .from('users')
    .select('id, empleadores_sicoss, casas_particulares')
    .eq('id', cliente_id)
    .eq('role', 'cliente')
    .eq('estudio_id', estudio_id)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: 'Error interno del servidor' };
  const c = data as { empleadores_sicoss: boolean; casas_particulares: boolean } | null;
  if (!c) return { ok: false, status: 404, error: 'Cliente no encontrado' };
  if (!c.empleadores_sicoss && !c.casas_particulares) {
    return { ok: false, status: 400, error: 'El cliente no tiene empleados (SICOSS / casas particulares)' };
  }
  return { ok: true };
}

// ============================================================
// CONTADOR — CRUD
// ============================================================

// POST /api/sueldos (multipart: cliente_id + empleado + periodo + monto + archivo opcional)
export async function crearSueldo(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, empleado, periodo, monto } = (req.body ?? {}) as {
    cliente_id?: string;
    empleado?: string;
    periodo?: string;
    monto?: string;
  };

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  const empleadoTrim = typeof empleado === 'string' ? empleado.trim() : '';
  if (empleadoTrim === '') {
    res.status(400).json({ error: 'empleado es requerido' });
    return;
  }
  const per = normalizarPeriodo(periodo);
  if (!per) {
    res.status(400).json({ error: 'periodo inválido (formato YYYY-MM)' });
    return;
  }
  const m = parseMonto(monto);
  if (m === null) {
    res.status(400).json({ error: 'monto inválido' });
    return;
  }

  // Procesar el PDF/imagen opcional antes de tocar la DB.
  let archivo: { buffer: Buffer; mime: string; ext: string } | null = null;
  if (req.file) {
    archivo = await procesarArchivo(req.file).catch(() => null);
    if (!archivo) {
      res.status(400).json({ error: 'Solo se aceptan imágenes (jpg, png, webp) o PDF' });
      return;
    }
  }

  try {
    const chk = await clienteHabilitado(estudio_id, cliente_id);
    if (!chk.ok) {
      res.status(chk.status).json({ error: chk.error });
      return;
    }

    let storage_path: string | null = null;
    if (archivo) {
      storage_path = `${estudio_id}/sueldos/${cliente_id}/${randomUUID()}.${archivo.ext}`;
      await subirComprobante(storage_path, archivo.buffer, archivo.mime);
    }

    const { data, error } = await supabase
      .from('sueldos')
      .insert({
        estudio_id,
        cliente_id,
        empleado: empleadoTrim,
        periodo: per,
        monto: m,
        storage_path,
        mime: archivo?.mime ?? null,
        size_bytes: archivo?.buffer.length ?? null,
        original_name: req.file?.originalname ?? null,
      })
      .select(SELECT_SUELDO)
      .single();

    if (error || !data) {
      // Rollback best-effort del objeto subido si la metadata no entró.
      if (storage_path) await borrarComprobante(storage_path);
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/sueldos?cliente_id=... (contador) — recibos de un cliente, más recientes primero.
export async function listarSueldos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.query.cliente_id;

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('sueldos')
      .select(SELECT_SUELDO)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .order('periodo', { ascending: false })
      .order('empleado', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(data ?? []);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/sueldos/:id (contador, multipart) — edita campos y opcionalmente reemplaza
// o quita el PDF. `quitar_archivo=true` borra el adjunto existente.
export async function actualizarSueldo(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { id } = req.params;
  const body = (req.body ?? {}) as {
    empleado?: string;
    periodo?: string;
    monto?: string;
    quitar_archivo?: string | boolean;
  };

  const patch: Record<string, unknown> = {};
  if (body.empleado !== undefined) {
    const empleadoTrim = typeof body.empleado === 'string' ? body.empleado.trim() : '';
    if (empleadoTrim === '') {
      res.status(400).json({ error: 'empleado es requerido' });
      return;
    }
    patch.empleado = empleadoTrim;
  }
  if (body.periodo !== undefined) {
    const per = normalizarPeriodo(body.periodo);
    if (!per) {
      res.status(400).json({ error: 'periodo inválido (formato YYYY-MM)' });
      return;
    }
    patch.periodo = per;
  }
  if (body.monto !== undefined) {
    const m = parseMonto(body.monto);
    if (m === null) {
      res.status(400).json({ error: 'monto inválido' });
      return;
    }
    patch.monto = m;
  }

  let archivo: { buffer: Buffer; mime: string; ext: string } | null = null;
  if (req.file) {
    archivo = await procesarArchivo(req.file).catch(() => null);
    if (!archivo) {
      res.status(400).json({ error: 'Solo se aceptan imágenes (jpg, png, webp) o PDF' });
      return;
    }
  }
  const quitar = body.quitar_archivo === 'true' || body.quitar_archivo === true;

  try {
    const { data: prev, error: prevError } = await supabase
      .from('sueldos')
      .select('id, cliente_id, storage_path')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (prevError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const existente = prev as { id: string; cliente_id: string; storage_path: string | null } | null;
    if (!existente) {
      res.status(404).json({ error: 'Recibo de sueldo no encontrado' });
      return;
    }

    // Subir el objeto nuevo primero (si vino). Si la DB falla, se limpia.
    let nuevoPath: string | null = null;
    if (archivo) {
      nuevoPath = `${estudio_id}/sueldos/${existente.cliente_id}/${randomUUID()}.${archivo.ext}`;
      await subirComprobante(nuevoPath, archivo.buffer, archivo.mime);
      patch.storage_path = nuevoPath;
      patch.mime = archivo.mime;
      patch.size_bytes = archivo.buffer.length;
      patch.original_name = req.file?.originalname ?? null;
    } else if (quitar) {
      patch.storage_path = null;
      patch.mime = null;
      patch.size_bytes = null;
      patch.original_name = null;
    }

    if (Object.keys(patch).length === 0) {
      // Nada para actualizar: devolver la fila tal cual.
      const { data } = await supabase.from('sueldos').select(SELECT_SUELDO).eq('id', id).single();
      res.json(data);
      return;
    }

    const { data, error } = await supabase
      .from('sueldos')
      .update(patch)
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .select(SELECT_SUELDO)
      .single();

    if (error || !data) {
      if (nuevoPath) await borrarComprobante(nuevoPath);
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    // Éxito: borrar el objeto viejo si se reemplazó o se quitó.
    if (existente.storage_path && (nuevoPath || quitar)) {
      await borrarComprobante(existente.storage_path);
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// DELETE /api/sueldos/:id (contador) — borra la fila y el objeto en Storage.
export async function borrarSueldo(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { id } = req.params;

  try {
    const { data: prev, error: prevError } = await supabase
      .from('sueldos')
      .select('id, storage_path')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (prevError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const existente = prev as { id: string; storage_path: string | null } | null;
    if (!existente) {
      res.status(404).json({ error: 'Recibo de sueldo no encontrado' });
      return;
    }

    const { error } = await supabase.from('sueldos').delete().eq('id', id).eq('estudio_id', estudio_id);
    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (existente.storage_path) await borrarComprobante(existente.storage_path);
    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/sueldos/:id/archivo (contador) — signed URL del PDF de un recibo del estudio.
export async function archivoSueldo(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('sueldos')
      .select('id, storage_path')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const row = data as { storage_path: string | null } | null;
    if (!row || !row.storage_path) {
      res.status(404).json({ error: 'No hay archivo para este recibo' });
      return;
    }

    const url = await signedUrlComprobante(row.storage_path);
    if (!url) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json({ url });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ============================================================
// CLIENTE — solo lectura
// ============================================================

// GET /api/sueldos/mios (cliente) — sus recibos de sueldo, más recientes primero.
export async function misSueldos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.user!.id;

  try {
    const { data, error } = await supabase
      .from('sueldos')
      .select(SELECT_SUELDO)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .order('periodo', { ascending: false })
      .order('empleado', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(data ?? []);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/sueldos/mis-sueldos/:id/archivo (cliente) — signed URL del PDF de un recibo PROPIO.
export async function miArchivoSueldo(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.user!.id;
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('sueldos')
      .select('id, storage_path')
      .eq('id', id)
      .eq('cliente_id', cliente_id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    const row = data as { storage_path: string | null } | null;
    if (!row || !row.storage_path) {
      res.status(404).json({ error: 'No hay archivo para este recibo' });
      return;
    }

    const url = await signedUrlComprobante(row.storage_path);
    if (!url) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json({ url });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
