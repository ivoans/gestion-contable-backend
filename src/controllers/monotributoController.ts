import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { UUID_REGEX, normalizeCuit } from '../utils/validators';
import { xlsxBufferAFilas } from '../utils/xlsxReader';
import { parsearMonotributo, MonotributoParseError } from '../utils/monotributoParser';

const ESCALA_FIELDS = 'id, estudio_id, categoria, tope_anual, orden, updated_at';
const FACTURACION_FIELDS = 'id, estudio_id, cliente_id, periodo, monto, comprobantes, origen, created_at';
const COMPROBANTE_FIELDS =
  'id, periodo, fecha, tipo, punto_venta, numero_desde, numero_hasta, doc_tipo_receptor, doc_nro_receptor, denominacion_receptor, imp_total';

// Ventana de recategorización: primer día del mes de hace 11 meses (incluye el mes actual → 12 meses).
function cutoff12Meses(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return d.toISOString().slice(0, 10);
}

// ============================================================
// ESCALA (contador/admin) — la edita por estudio. Los clientes NO la ven.
// ============================================================

// GET /api/monotributo/escala
export async function getEscala(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  try {
    const { data, error } = await supabase
      .from('monotributo_escala')
      .select(ESCALA_FIELDS)
      .eq('estudio_id', estudio_id)
      .order('orden', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(data ?? []);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PUT /api/monotributo/escala — reemplaza el set completo de filas (letra + tope).
export async function upsertEscala(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const body = (req.body ?? {}) as { escala?: unknown };

  if (!Array.isArray(body.escala)) {
    res.status(400).json({ error: 'escala debe ser un array' });
    return;
  }

  // Validar y normalizar cada fila.
  const items: { categoria: string; tope_anual: number }[] = [];
  const vistas = new Set<string>();
  for (const raw of body.escala) {
    const it = raw as { categoria?: unknown; tope_anual?: unknown };
    const categoria = typeof it.categoria === 'string' ? it.categoria.trim() : '';
    const tope = typeof it.tope_anual === 'number' ? it.tope_anual : Number(it.tope_anual);
    if (categoria === '') {
      res.status(400).json({ error: 'cada fila necesita una categoría (letra)' });
      return;
    }
    if (!Number.isFinite(tope) || tope <= 0) {
      res.status(400).json({ error: `tope_anual inválido para la categoría ${categoria}` });
      return;
    }
    const key = categoria.toUpperCase();
    if (vistas.has(key)) {
      res.status(400).json({ error: `categoría duplicada: ${categoria}` });
      return;
    }
    vistas.add(key);
    items.push({ categoria, tope_anual: tope });
  }

  // Ordenar por tope ascendente → orden monotónico (la posición del cliente depende de esto).
  items.sort((a, b) => a.tope_anual - b.tope_anual);
  const rows = items.map((it, i) => ({
    estudio_id,
    categoria: it.categoria,
    tope_anual: it.tope_anual,
    orden: i,
  }));

  try {
    // Reemplazo: borrar las del estudio e insertar las nuevas.
    const { error: delError } = await supabase
      .from('monotributo_escala')
      .delete()
      .eq('estudio_id', estudio_id);
    if (delError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (rows.length === 0) {
      res.json([]);
      return;
    }

    const { data, error } = await supabase
      .from('monotributo_escala')
      .insert(rows)
      .select(ESCALA_FIELDS)
      .order('orden', { ascending: true });
    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ============================================================
// FACTURACIÓN (contador) — import del export AFIP por cliente.
// ============================================================

// POST /api/monotributo/facturacion/import (multipart: archivo + cliente_id)
export async function importarFacturacion(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id } = (req.body ?? {}) as { cliente_id?: string };

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'El archivo .xlsx es requerido en el campo "archivo"' });
    return;
  }

  try {
    const { data: cliente, error: clienteError } = await supabase
      .from('users')
      .select('id, cuit, condicion_fiscal')
      .eq('id', cliente_id)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (clienteError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!cliente) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }
    if ((cliente as { condicion_fiscal: string | null }).condicion_fiscal !== 'monotributista') {
      res.status(400).json({ error: 'El cliente no es monotributista' });
      return;
    }

    let parsed;
    try {
      parsed = parsearMonotributo(xlsxBufferAFilas(req.file.buffer));
    } catch (err) {
      const msg = err instanceof MonotributoParseError ? err.message : 'No se pudo leer el archivo .xlsx';
      res.status(400).json({ error: msg });
      return;
    }

    // Si el archivo trae CUIT y el cliente tiene uno cargado, deben coincidir.
    const clienteCuit = normalizeCuit((cliente as { cuit: string | null }).cuit);
    if (parsed.cuit && clienteCuit && parsed.cuit !== clienteCuit) {
      res.status(400).json({ error: 'El CUIT del archivo no coincide con el del cliente' });
      return;
    }

    const rows = parsed.periodos.map((p) => ({
      estudio_id,
      cliente_id,
      periodo: p.periodo,
      monto: p.monto,
      comprobantes: p.comprobantes,
      origen: 'importado',
    }));

    const { error } = await supabase
      .from('monotributo_facturacion')
      .upsert(rows, { onConflict: 'cliente_id,periodo' });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    // Detalle (comprobante a comprobante), idempotente por período: se borran los
    // comprobantes de los meses presentes en el archivo y se insertan los nuevos.
    const periodosArchivo = parsed.periodos.map((p) => p.periodo);
    const { error: delError } = await supabase
      .from('monotributo_comprobantes')
      .delete()
      .eq('cliente_id', cliente_id)
      .in('periodo', periodosArchivo);
    if (delError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const detalleRows = parsed.detalle.map((c) => ({
      estudio_id,
      cliente_id,
      periodo: c.periodo,
      fecha: c.fecha,
      tipo: c.tipo,
      punto_venta: c.punto_venta || null,
      numero_desde: c.numero_desde || null,
      numero_hasta: c.numero_hasta || null,
      doc_tipo_receptor: c.doc_tipo_receptor || null,
      doc_nro_receptor: c.doc_nro_receptor || null,
      denominacion_receptor: c.denominacion_receptor || null,
      imp_total: c.imp_total,
    }));

    if (detalleRows.length > 0) {
      const { error: insError } = await supabase
        .from('monotributo_comprobantes')
        .insert(detalleRows);
      if (insError) {
        res.status(500).json({ error: 'Error interno del servidor' });
        return;
      }
    }

    res.json({ importados: rows.length, comprobantes: detalleRows.length, periodos: parsed.periodos });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/monotributo/facturacion?cliente_id=... (contador) — verificación / vista del contador.
export async function getFacturacionCliente(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.query.cliente_id;

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('monotributo_facturacion')
      .select(FACTURACION_FIELDS)
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .order('periodo', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(data ?? []);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ============================================================
// CLIENTE — su propia facturación + posición vs escala (sin exponer la tabla).
// ============================================================

interface EscalaRow {
  categoria: string;
  tope_anual: number;
  orden: number;
}

// Calcula la posición del cliente en la escala a partir del acumulado de 12 meses.
function calcularPosicion(escala: EscalaRow[], acumulado: number) {
  if (escala.length === 0) {
    return {
      categoria: null as string | null,
      tope: null as number | null,
      porcentaje: null as number | null,
      proximo: null as { categoria: string; tope: number } | null,
      excedido: false,
      escala_configurada: false,
    };
  }
  // escala ya viene ordenada por orden (= tope ascendente).
  const idx = escala.findIndex((e) => acumulado <= Number(e.tope_anual));
  if (idx === -1) {
    // Supera el último tope.
    const ultima = escala[escala.length - 1];
    return {
      categoria: ultima.categoria,
      tope: Number(ultima.tope_anual),
      porcentaje: Number(ultima.tope_anual) > 0 ? acumulado / Number(ultima.tope_anual) : null,
      proximo: null,
      excedido: true,
      escala_configurada: true,
    };
  }
  const actual = escala[idx];
  const proximo = idx + 1 < escala.length ? escala[idx + 1] : null;
  return {
    categoria: actual.categoria,
    tope: Number(actual.tope_anual),
    porcentaje: Number(actual.tope_anual) > 0 ? acumulado / Number(actual.tope_anual) : null,
    proximo: proximo ? { categoria: proximo.categoria, tope: Number(proximo.tope_anual) } : null,
    excedido: false,
    escala_configurada: true,
  };
}

// Arma el resumen (serie 12m + posición vs escala) de un cliente. Scopeado por
// estudio_id (multi-tenant). Reusado por el cliente (su propio id) y el contador.
async function armarResumen(
  estudio_id: string | null,
  cliente_id: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false }> {
  const desde = cutoff12Meses();
  const [factRes, escalaRes] = await Promise.all([
    supabase
      .from('monotributo_facturacion')
      .select('periodo, monto, comprobantes')
      .eq('estudio_id', estudio_id)
      .eq('cliente_id', cliente_id)
      .gte('periodo', desde)
      .order('periodo', { ascending: true }),
    supabase
      .from('monotributo_escala')
      .select('categoria, tope_anual, orden')
      .eq('estudio_id', estudio_id)
      .order('orden', { ascending: true }),
  ]);

  if (factRes.error || escalaRes.error) return { ok: false };

  const facturacion = (factRes.data ?? []) as { periodo: string; monto: number; comprobantes: number }[];
  const escala = (escalaRes.data ?? []) as EscalaRow[];
  const acumulado = Math.round(facturacion.reduce((s, f) => s + Number(f.monto), 0) * 100) / 100;

  return {
    ok: true,
    data: { facturacion, acumulado_12m: acumulado, ...calcularPosicion(escala, acumulado) },
  };
}

// GET /api/monotributo/mio (cliente) — serie 12m + posición. NO devuelve la escala completa.
export async function getMio(req: Request, res: Response): Promise<void> {
  try {
    const r = await armarResumen(req.user!.estudio_id, req.user!.id);
    if (!r.ok) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(r.data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/monotributo/resumen?cliente_id=... (contador) — el mismo resumen que ve el
// cliente, pero para el cliente que elige la contadora (como el libro IVA).
export async function getResumenCliente(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.query.cliente_id;

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }

  try {
    const r = await armarResumen(estudio_id, cliente_id);
    if (!r.ok) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(r.data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ============================================================
// DETALLE — comprobantes de un período (vista tipo Libro IVA).
// ============================================================

// Valida ?anio=&mes= y devuelve el primer día del mes como 'YYYY-MM-01'.
function periodoDeQuery(req: Request): string | null {
  const anio = Number(req.query.anio);
  const mes = Number(req.query.mes);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return null;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-01`;
}

// Lee los comprobantes de un cliente para un período. Scopeado por estudio_id.
async function armarComprobantes(
  estudio_id: string | null,
  cliente_id: string,
  periodo: string,
): Promise<{ ok: true; data: unknown[] } | { ok: false }> {
  const { data, error } = await supabase
    .from('monotributo_comprobantes')
    .select(COMPROBANTE_FIELDS)
    .eq('estudio_id', estudio_id)
    .eq('cliente_id', cliente_id)
    .eq('periodo', periodo)
    .order('fecha', { ascending: true })
    .order('numero_desde', { ascending: true });

  if (error) return { ok: false };
  return { ok: true, data: data ?? [] };
}

// GET /api/monotributo/mio/comprobantes?anio=&mes= (cliente) — su propio detalle.
export async function getMisComprobantes(req: Request, res: Response): Promise<void> {
  const periodo = periodoDeQuery(req);
  if (!periodo) {
    res.status(400).json({ error: 'anio y mes son requeridos y deben ser válidos' });
    return;
  }
  try {
    const r = await armarComprobantes(req.user!.estudio_id, req.user!.id, periodo);
    if (!r.ok) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(r.data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/monotributo/comprobantes?cliente_id=&anio=&mes= (contador) — detalle del
// cliente que elige la contadora.
export async function getComprobantesCliente(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const cliente_id = req.query.cliente_id;

  if (typeof cliente_id !== 'string' || !UUID_REGEX.test(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  const periodo = periodoDeQuery(req);
  if (!periodo) {
    res.status(400).json({ error: 'anio y mes son requeridos y deben ser válidos' });
    return;
  }
  try {
    const r = await armarComprobantes(estudio_id, cliente_id, periodo);
    if (!r.ok) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    res.json(r.data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
