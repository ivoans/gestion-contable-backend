import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { isValidEmail } from '../utils/validators';

const USER_FIELDS = 'id, estudio_id, nombre, email, role, cuit, telefono, activo, created_at';
const ESTUDIO_FIELDS = 'id, nombre, activo, comprobantes_habilitados, created_at';

export async function crearContador(req: Request, res: Response): Promise<void> {
  const { nombre, email, password, estudio_id } = req.body as {
    nombre?: string;
    email?: string;
    password?: string;
    estudio_id?: string;
  };

  if (!nombre || !email || !password || !estudio_id) {
    res.status(400).json({ error: 'nombre, email, password y estudio_id son requeridos' });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Email inválido' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    return;
  }

  try {
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      res.status(409).json({ error: 'Email ya registrado' });
      return;
    }

    const { data: estudio } = await supabase
      .from('estudios')
      .select('id, activo')
      .eq('id', estudio_id)
      .maybeSingle();

    if (!estudio || !estudio.activo) {
      res.status(400).json({ error: 'Estudio no existe o está inactivo' });
      return;
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({ nombre, email, password_hash, estudio_id, role: 'contador', activo: true })
      .select(USER_FIELDS)
      .single();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json(user);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function listarContadores(_req: Request, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .eq('role', 'contador')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function listarEstudios(_req: Request, res: Response): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('estudios')
      .select(ESTUDIO_FIELDS)
      .eq('activo', true)
      .order('nombre', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// PATCH /api/admin/estudios/:id/comprobantes — el admin prende/apaga la subida de
// comprobantes para un estudio. Apagado por defecto: así no se usa Storage hasta
// decidirlo. Body: { habilitado: boolean }.
export async function actualizarComprobantesEstudio(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { habilitado } = req.body as { habilitado?: unknown };

  if (typeof habilitado !== 'boolean') {
    res.status(400).json({ error: 'habilitado debe ser true o false' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('estudios')
      .update({ comprobantes_habilitados: habilitado })
      .eq('id', id)
      .select(ESTUDIO_FIELDS)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'Estudio no encontrado' });
      return;
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function obtenerContador(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .eq('id', id)
      .eq('role', 'contador')
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Contador no encontrado' });
      return;
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function actualizarContador(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { nombre, email } = req.body as { nombre?: string; email?: string };

  if (email !== undefined && !isValidEmail(email)) {
    res.status(400).json({ error: 'Email inválido' });
    return;
  }

  try {
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('role', 'contador')
      .maybeSingle();

    if (!existing) {
      res.status(404).json({ error: 'Contador no encontrado' });
      return;
    }

    if (email) {
      const { data: emailUser } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', id)
        .maybeSingle();

      if (emailUser) {
        res.status(409).json({ error: 'Email ya registrado' });
        return;
      }
    }

    const updates: Partial<Pick<User, 'nombre' | 'email'>> = {};
    if (nombre !== undefined) updates.nombre = nombre;
    if (email !== undefined) updates.email = email;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No se enviaron campos para actualizar' });
      return;
    }

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select(USER_FIELDS)
      .single();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function actualizarEstadoContador(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { activo } = req.body as { activo?: boolean };

  if (activo === undefined || typeof activo !== 'boolean') {
    res.status(400).json({ error: 'activo (boolean) requerido' });
    return;
  }

  try {
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('role', 'contador')
      .maybeSingle();

    if (!existing) {
      res.status(404).json({ error: 'Contador no encontrado' });
      return;
    }

    const { error } = await supabase
      .from('users')
      .update({ activo })
      .eq('id', id);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json({ message: 'Estado actualizado', activo });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
