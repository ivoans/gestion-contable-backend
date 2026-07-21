import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { isValidUuid } from '../utils/validators';
import { getDateAR } from '../utils/fechas';
import { descargarComprobante } from '../lib/storage';
import { armarEstadoCuenta, armarCobranzas } from '../services/estadoCuentaService';
import { renderEstadoCuentaPdf, EstadoCuentaPdfData } from '../services/estadoCuentaPdfService';
import { EstadoCuenta } from '../types';

const CONDICION_LABEL: Record<string, string> = {
  monotributista: 'MONOTRIBUTO',
  responsable_inscripto: 'RESPONSABLE INSCRIPTO',
};

type EstudioIdent = {
  nombre: string;
  domicilio: string | null;
  cuit: string | null;
  telefono: string | null;
  email: string | null;
  condicion_iva: string | null;
  logo_path: string | null;
};

type ClienteIdent = {
  nombre: string;
  domicilio: string | null;
  cuit: string | null;
  telefono: string | null;
  email: string | null;
  condicion_fiscal: string | null;
};

// Arma el PDF del estado de cuenta de un cliente. Devuelve null si el cliente no existe
// en el estudio (→ 404). Reusa la cadena de identidad estudio+logo de recibosController.
async function construirPdf(estudioId: string, clienteId: string): Promise<Buffer | null> {
  const estado = await armarEstadoCuenta(estudioId, clienteId);

  const { data: est, error: estErr } = await supabase
    .from('estudios')
    .select('nombre, domicilio, cuit, telefono, email, condicion_iva, logo_path')
    .eq('id', estudioId)
    .maybeSingle();
  if (estErr || !est) throw estErr ?? new Error('estudio no encontrado');
  const estudio = est as EstudioIdent;

  const { data: cli, error: cliErr } = await supabase
    .from('users')
    .select('nombre, domicilio, cuit, telefono, email, condicion_fiscal')
    .eq('id', clienteId)
    .eq('estudio_id', estudioId)
    .eq('role', 'cliente')
    .maybeSingle();
  if (cliErr) throw cliErr;
  if (!cli) return null;
  const cliente = cli as ClienteIdent;

  const logo = estudio.logo_path ? await descargarComprobante(estudio.logo_path) : null;

  const pdfData: EstadoCuentaPdfData = {
    estudio: {
      nombre: estudio.nombre,
      domicilio: estudio.domicilio,
      telefono: estudio.telefono,
      email: estudio.email,
      condicion_iva: estudio.condicion_iva,
      cuit: estudio.cuit,
    },
    cliente: {
      nombre: cliente.nombre,
      domicilio: cliente.domicilio,
      cuit: cliente.cuit,
      telefono: cliente.telefono,
      email: cliente.email,
      condicion: cliente.condicion_fiscal ? CONDICION_LABEL[cliente.condicion_fiscal] ?? null : null,
    },
    fecha: getDateAR(),
    bloques: [
      { titulo: 'Impuestos', items: estado.impuestos.items, subtotal: estado.impuestos.subtotal },
      { titulo: 'Estudio', items: estado.estudio.items, subtotal: estado.estudio.subtotal },
    ],
    total: estado.total,
    aging: estado.aging,
    logo,
  };

  return renderEstadoCuentaPdf(pdfData);
}

function enviarPdf(res: Response, pdf: Buffer, nombreArchivo: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivo}"`);
  res.send(pdf);
}

// ── CLIENTE ──────────────────────────────────────────────────────────────────

// GET /api/cuenta-corriente/mio — el cliente ve su estado de cuenta unificado.
export async function miEstadoCuenta(req: Request, res: Response): Promise<void> {
  try {
    const estado = await armarEstadoCuenta(req.user!.estudio_id!, req.user!.id);
    res.json(estado);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/cuenta-corriente/mio/pdf — el cliente descarga su estado de cuenta en PDF.
export async function miEstadoCuentaPdf(req: Request, res: Response): Promise<void> {
  try {
    const pdf = await construirPdf(req.user!.estudio_id!, req.user!.id);
    if (!pdf) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }
    enviarPdf(res, pdf, 'estado-de-cuenta.pdf');
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── CONTADOR ──────────────────────────────────────────────────────────────────

// GET /api/cuenta-corriente?cliente_id= — estado de cuenta de un cliente del estudio.
export async function estadoCuentaCliente(req: Request, res: Response): Promise<void> {
  const { cliente_id } = req.query as { cliente_id?: string };
  if (!cliente_id || !isValidUuid(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  try {
    const estado: EstadoCuenta = await armarEstadoCuenta(req.user!.estudio_id!, cliente_id);
    res.json(estado);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/cuenta-corriente/pdf?cliente_id= — PDF del estado de cuenta de un cliente.
export async function estadoCuentaPdf(req: Request, res: Response): Promise<void> {
  const { cliente_id } = req.query as { cliente_id?: string };
  if (!cliente_id || !isValidUuid(cliente_id)) {
    res.status(400).json({ error: 'cliente_id debe ser un uuid válido' });
    return;
  }
  try {
    const pdf = await construirPdf(req.user!.estudio_id!, cliente_id);
    if (!pdf) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }
    enviarPdf(res, pdf, 'estado-de-cuenta.pdf');
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/cobranzas — dashboard global de cobranzas del estudio (aging por cliente).
export async function cobranzas(req: Request, res: Response): Promise<void> {
  try {
    const filas = await armarCobranzas(req.user!.estudio_id!);
    res.json(filas);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
