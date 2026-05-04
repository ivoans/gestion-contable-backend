import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { User } from '../types';

const USER_FIELDS = 'id, estudio_id, nombre, email, role, cuit, telefono, activo, created_at';

export async function crearCliente(req: Request, res: Response): Promise<void> {
  const { nombre, email, password, cuit, telefono } = req.body as {
    nombre?: string;
    email?: string;
    password?: string;
    cuit?: string;
    telefono?: string;
  };

  if (!nombre || !email || !password) {
    res.status(400).json({ error: 'nombre, email y password son requeridos' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    return;
  }

  const estudio_id = req.user!.estudio_id;

  try {
    const { data: existing, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (checkError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (existing) {
      res.status(409).json({ error: 'Email ya registrado' });
      return;
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from('users')
      .insert({
        nombre,
        email,
        password_hash,
        cuit: cuit ?? null,
        telefono: telefono ?? null,
        role: 'cliente',
        estudio_id,
        activo: true,
      })
      .select(USER_FIELDS)
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(201).json(data as User);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function listarClientes(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .order('nombre', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as User[]);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function obtenerCliente(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('users')
      .select(USER_FIELDS)
      .eq('id', id)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    res.json(data as User);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function actualizarCliente(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { nombre, email, cuit, telefono } = req.body as {
    nombre?: string;
    email?: string;
    cuit?: string;
    telefono?: string;
  };

  const updates: Partial<Record<string, unknown>> = {};
  if (nombre !== undefined) updates.nombre = nombre;
  if (email !== undefined) updates.email = email;
  if (cuit !== undefined) updates.cuit = cuit;
  if (telefono !== undefined) updates.telefono = telefono;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No se enviaron campos para actualizar' });
    return;
  }

  try {
    const { data: existing, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Cliente no encontrado' });
      return;
    }

    if (email) {
      const { data: emailTaken, error: emailError } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .neq('id', id)
        .maybeSingle();

      if (emailError) {
        res.status(500).json({ error: 'Error interno del servidor' });
        return;
      }

      if (emailTaken) {
        res.status(409).json({ error: 'Email ya registrado' });
        return;
      }
    }

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', id)
      .select(USER_FIELDS)
      .single();

    if (error || !data) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json(data as User);
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

export async function actualizarEstadoCliente(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { activo } = req.body as { activo?: boolean };

  if (typeof activo !== 'boolean') {
    res.status(400).json({ error: 'activo debe ser boolean' });
    return;
  }

  try {
    const { data: existing, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('role', 'cliente')
      .eq('estudio_id', estudio_id)
      .maybeSingle();

    if (findError) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!existing) {
      res.status(404).json({ error: 'Cliente no encontrado' });
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
