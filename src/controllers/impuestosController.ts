import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { Impuesto, EstadoImpuesto } from '../types';
import { sendNuevoImpuesto } from '../services/emailService';

export async function crearImpuesto(req: Request, res: Response): Promise<void> {
  const { cliente_id, tipo, monto, fecha_vencimiento, descripcion, link_pago } = req.body as {
    cliente_id?: string;
    tipo?: string;
    monto?: number;
    fecha_vencimiento?: string;
    descripcion?: string;
    link_pago?: string;
  };

  if (!cliente_id || !tipo || monto === undefined || !fecha_vencimiento) {
    res.status(400).json({ error: 'cliente_id, tipo, monto y fecha_vencimiento son requeridos' });
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento) || isNaN(Date.parse(fecha_vencimiento))) {
    res.status(400).json({ error: 'Fecha de vencimiento debe tener formato YYYY-MM-DD' });
    return;
  }

  const estudio_id = req.user!.estudio_id;

  try {
    const { data: cliente, error: clienteError } = await supabase
      .from('users')
      .select('id')
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

    const { data, error } = await supabase
      .from('impuestos')
      .insert({
        estudio_id,
        cliente_id,
        creado_por: req.user!.id,
        tipo,
        monto,
        fecha_vencimiento,
        descripcion: descripcion ?? null,
        link_pago: link_pago ?? null,
        estado: 'pendiente',
      })
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const nuevoImpuesto = data as Impuesto;

    try {
      const { data: clienteData } = await supabase
        .from('users')
        .select('email, nombre')
        .eq('id', cliente_id)
        .single();

      if (clienteData) {
        await sendNuevoImpuesto(clienteData.email, {
          nombre: clienteData.nombre,
          tipo: nuevoImpuesto.tipo,
          monto: nuevoImpuesto.monto,
          fecha_vencimiento: nuevoImpuesto.fecha_vencimiento,
          link_pago: nuevoImpuesto.link_pago ?? undefined,
        });

        await supabase.from('notificaciones').insert({
          impuesto_id: nuevoImpuesto.id,
          user_id: cliente_id,
          tipo: 'nuevo',
          canal: 'email',
        });
      }
    } catch (emailErr) {
      console.error('[crearImpuesto] Email fail, impuesto creado OK:', emailErr);
    }

    res.status(201).json(nuevoImpuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function listarImpuestos(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;
  const { cliente_id, estado } = req.query as { cliente_id?: string; estado?: string };

  try {
    let query = supabase
      .from('impuestos')
      .select('*')
      .eq('estudio_id', estudio_id)
      .order('fecha_vencimiento', { ascending: true });

    if (cliente_id) query = query.eq('cliente_id', cliente_id);
    if (estado) query = query.eq('estado', estado);

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Impuesto[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function obtenerImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('impuestos')
      .select('*')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function actualizarImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { tipo, monto, fecha_vencimiento, descripcion, link_pago } = req.body as {
    tipo?: string;
    monto?: number;
    fecha_vencimiento?: string;
    descripcion?: string;
    link_pago?: string;
  };

  try {
    const { data: existing, error: findError } = await supabase
      .from('impuestos')
      .select('id, estado')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (fecha_vencimiento !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento) || isNaN(Date.parse(fecha_vencimiento)))) {
    res.status(400).json({ error: 'Fecha de vencimiento debe tener formato YYYY-MM-DD' });
    return;
  }

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    if ((existing as { id: string; estado: EstadoImpuesto }).estado === 'pagado') {
      res.status(400).json({ error: 'No se puede editar un impuesto pagado' });
      return;
    }

    const updates: Partial<Record<string, unknown>> = {};
    if (tipo !== undefined) updates.tipo = tipo;
    if (monto !== undefined) updates.monto = monto;
    if (fecha_vencimiento !== undefined) updates.fecha_vencimiento = fecha_vencimiento;
    if (descripcion !== undefined) updates.descripcion = descripcion;
    if (link_pago !== undefined) updates.link_pago = link_pago;

    const { data, error } = await supabase
      .from('impuestos')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function cambiarEstadoImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: findError } = await supabase
      .from('impuestos')
      .select('id, estado')
      .eq('id', id)
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    if ((existing as { id: string; estado: EstadoImpuesto }).estado === 'pagado') {
      res.status(400).json({ error: 'El impuesto ya está pagado' });
      return;
    }

    const { data, error } = await supabase
      .from('impuestos')
      .update({
        estado: 'pagado',
        pagado_at: new Date().toISOString(),
        pagado_por: req.user!.id,
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function misImpuestos(req: Request, res: Response): Promise<void> {
  const cliente_id = req.user!.id;

  try {
    const { data, error } = await supabase
      .from('impuestos')
      .select('*')
      .eq('cliente_id', cliente_id)
      .order('fecha_vencimiento', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    const impuestos = data as Impuesto[];
    res.json({
      pendientes: impuestos.filter((i) => i.estado === 'pendiente'),
      vencidos: impuestos.filter((i) => i.estado === 'vencido'),
      pagados: impuestos.filter((i) => i.estado === 'pagado'),
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function miImpuesto(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const cliente_id = req.user!.id;

  try {
    const { data, error } = await supabase
      .from('impuestos')
      .select('*')
      .eq('id', id)
      .eq('cliente_id', cliente_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Impuesto no encontrado' });
      return;
    }

    res.json(data as Impuesto);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
