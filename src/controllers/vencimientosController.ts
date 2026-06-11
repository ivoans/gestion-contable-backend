import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { Vencimiento, Obligacion } from '../types';

const VENCIMIENTO_FIELDS =
  'id, estudio_id, obligacion, terminacion_cuit, anio, mes, fecha_vencimiento, created_at';

const OBLIGACIONES_VALIDAS: Obligacion[] = ['monotributo', 'iva', 'autonomos', 'ingresos_brutos'];

const ANIO_MIN = 2024;
const ANIO_MAX = 2100;
const MAX_ENTRIES = 500;

type EntryInput = {
  obligacion?: unknown;
  terminacion_cuit?: unknown;
  anio?: unknown;
  mes?: unknown;
  fecha_vencimiento?: unknown;
};

type EntryRow = {
  estudio_id: string;
  obligacion: Obligacion;
  terminacion_cuit: number | null;
  anio: number;
  mes: number;
  fecha_vencimiento: string;
};

// GET /api/vencimientos?anio=&obligacion=
export async function listarVencimientos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { anio: anioParam, obligacion } = req.query as { anio?: string; obligacion?: string };

  let anio: number;
  if (anioParam === undefined) {
    anio = new Date().getFullYear();
  } else {
    anio = Number(anioParam);
    if (!Number.isInteger(anio) || anio < ANIO_MIN || anio > ANIO_MAX) {
      res.status(400).json({ error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}` });
      return;
    }
  }

  if (obligacion !== undefined && !OBLIGACIONES_VALIDAS.includes(obligacion as Obligacion)) {
    res.status(400).json({ error: `obligacion debe ser una de: ${OBLIGACIONES_VALIDAS.join(', ')}` });
    return;
  }

  try {
    let query = supabase
      .from('vencimientos')
      .select(VENCIMIENTO_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('anio', anio)
      .order('obligacion', { ascending: true })
      .order('mes', { ascending: true })
      .order('terminacion_cuit', { ascending: true, nullsFirst: true });

    if (obligacion !== undefined) query = query.eq('obligacion', obligacion as Obligacion);

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Vencimiento[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PUT /api/vencimientos — reemplazo declarativo del calendario de UN año:
// upsertea las entries recibidas y BORRA las filas del año que no estén en la
// lista (B1: vaciar una celda en la UI debe borrar la fila en DB). entries
// puede ser [] para limpiar el año completo.
export async function reemplazarVencimientosAnio(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id!; // contador siempre tiene estudio (chk_estudio_por_role)
  const { anio: anioBody, entries } = req.body as { anio?: unknown; entries?: unknown };

  if (!Number.isInteger(anioBody) || (anioBody as number) < ANIO_MIN || (anioBody as number) > ANIO_MAX) {
    res.status(400).json({ error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}` });
    return;
  }
  const anio = anioBody as number;

  if (!Array.isArray(entries)) {
    res.status(400).json({ error: 'entries debe ser un array' });
    return;
  }

  if (entries.length > MAX_ENTRIES) {
    res.status(400).json({ error: `entries no puede superar ${MAX_ENTRIES} elementos` });
    return;
  }

  const rows: EntryRow[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as EntryInput;
    const prefix = `entries[${i}]`;

    if (!OBLIGACIONES_VALIDAS.includes(e.obligacion as Obligacion)) {
      res.status(400).json({ error: `${prefix}.obligacion debe ser una de: ${OBLIGACIONES_VALIDAS.join(', ')}` });
      return;
    }

    let terminacion_cuit: number | null;
    if (e.terminacion_cuit === null || e.terminacion_cuit === undefined) {
      terminacion_cuit = null;
    } else if (Number.isInteger(e.terminacion_cuit) && (e.terminacion_cuit as number) >= 0 && (e.terminacion_cuit as number) <= 9) {
      terminacion_cuit = e.terminacion_cuit as number;
    } else {
      res.status(400).json({ error: `${prefix}.terminacion_cuit debe ser null o un entero entre 0 y 9` });
      return;
    }

    if (!Number.isInteger(e.anio) || (e.anio as number) < ANIO_MIN || (e.anio as number) > ANIO_MAX) {
      res.status(400).json({ error: `${prefix}.anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}` });
      return;
    }

    if ((e.anio as number) !== anio) {
      res.status(400).json({ error: `${prefix}.anio debe coincidir con anio del body (${anio})` });
      return;
    }

    if (!Number.isInteger(e.mes) || (e.mes as number) < 1 || (e.mes as number) > 12) {
      res.status(400).json({ error: `${prefix}.mes debe ser un entero entre 1 y 12` });
      return;
    }

    const fecha = e.fecha_vencimiento;
    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(Date.parse(fecha))) {
      res.status(400).json({ error: `${prefix}.fecha_vencimiento debe tener formato YYYY-MM-DD` });
      return;
    }

    rows.push({
      estudio_id,
      obligacion: e.obligacion as Obligacion,
      terminacion_cuit,
      anio: e.anio as number,
      mes: e.mes as number,
      fecha_vencimiento: fecha,
    });
  }

  // Dedup por la clave de conflicto: Postgres no permite que un ON CONFLICT
  // afecte la misma fila dos veces en un solo comando. Conservamos la última.
  // Como todas las entries son del mismo año, la clave omite anio.
  const deduped = new Map<string, EntryRow>();
  for (const r of rows) {
    const key = `${r.obligacion}|${r.terminacion_cuit ?? 'null'}|${r.mes}`;
    deduped.set(key, r);
  }

  try {
    // 1) Upsert de lo declarado (si hay algo que declarar).
    let upserted: Vencimiento[] = [];
    if (deduped.size > 0) {
      const { data, error } = await supabase
        .from('vencimientos')
        .upsert([...deduped.values()], {
          onConflict: 'estudio_id, obligacion, terminacion_cuit, anio, mes',
        })
        .select(VENCIMIENTO_FIELDS);

      if (error || !data) {
        res.status(500).json({ error: 'Error interno del servidor' });
        return;
      }
      upserted = data as Vencimiento[];
    }

    // 2) Borrar las filas del año que NO están declaradas (celdas vaciadas).
    //    Se hace después del upsert: si algo falla a mitad de camino, lo
    //    declarado ya quedó persistido y solo sobran filas viejas.
    const { data: existentes, error: selectError } = await supabase
      .from('vencimientos')
      .select('id, obligacion, terminacion_cuit, mes')
      .eq('estudio_id', estudio_id)
      .eq('anio', anio);

    if (selectError || !existentes) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const staleIds = (existentes as Pick<Vencimiento, 'id' | 'obligacion' | 'terminacion_cuit' | 'mes'>[])
      .filter((v) => !deduped.has(`${v.obligacion}|${v.terminacion_cuit ?? 'null'}|${v.mes}`))
      .map((v) => v.id);

    if (staleIds.length > 0) {
      const { error: deleteError } = await supabase
        .from('vencimientos')
        .delete()
        .eq('estudio_id', estudio_id)
        .in('id', staleIds);

      if (deleteError) {
        res.status(500).json({ error: 'Error interno del servidor' });
        return;
      }
    }

    res.json({ count: upserted.length, deleted: staleIds.length, data: upserted });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// DELETE /api/vencimientos/:id
export async function eliminarVencimiento(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('vencimientos')
      .delete()
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .select('id');

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data || data.length === 0) {
      res.status(404).json({ error: 'Vencimiento no encontrado' });
      return;
    }

    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
