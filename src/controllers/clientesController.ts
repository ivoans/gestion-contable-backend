import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { CondicionFiscal, User } from '../types';
import { isValidCuit, isValidEmail, normalizeCuit } from '../utils/validators';

const USER_FIELDS =
  'id, estudio_id, nombre, email, role, cuit, condicion_fiscal, categoria, convenio_multilateral, empleadores_sicoss, casas_particulares, telefono, activo, created_at';

const CONDICIONES_FISCALES: readonly CondicionFiscal[] = ['monotributista', 'responsable_inscripto'];

function isValidCondicionFiscal(value: unknown): value is CondicionFiscal {
  return CONDICIONES_FISCALES.includes(value as CondicionFiscal);
}

// Flags de impuestos opcionales. Opcionales en el body (default false); si
// vienen deben ser boolean. Los tres aplican a ambas condiciones fiscales
// (sicoss/casas se habilitaron para monotributistas el 2026-07-14).
type FlagsOpcionales = {
  convenio_multilateral: boolean;
  empleadores_sicoss: boolean;
  casas_particulares: boolean;
};

function validarFlagsOpcionales(
  body: Record<string, unknown>,
): { ok: true; flags: FlagsOpcionales } | { ok: false; error: string } {
  const flags: FlagsOpcionales = {
    convenio_multilateral: false,
    empleadores_sicoss: false,
    casas_particulares: false,
  };

  for (const key of Object.keys(flags) as (keyof FlagsOpcionales)[]) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return { ok: false, error: `${key} debe ser boolean` };
    }
    flags[key] = value;
  }

  return { ok: true, flags };
}

export async function crearCliente(req: Request, res: Response): Promise<void> {
  const { nombre, email, password, cuit, condicion_fiscal, categoria, telefono } = req.body as {
    nombre?: string;
    email?: string;
    password?: string;
    cuit?: string;
    condicion_fiscal?: string;
    categoria?: string | null;
    telefono?: string;
  };

  if (!nombre || !email || !password) {
    res.status(400).json({ error: 'nombre, email y password son requeridos' });
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

  if (!isValidCondicionFiscal(condicion_fiscal)) {
    res.status(400).json({ error: 'condicion_fiscal inválida' });
    return;
  }

  const cuitNormalizado = normalizeCuit(cuit);
  if (!isValidCuit(cuit) || !cuitNormalizado) {
    res.status(400).json({ error: 'CUIT inválido' });
    return;
  }

  const flagsResult = validarFlagsOpcionales(req.body as Record<string, unknown>);
  if (!flagsResult.ok) {
    res.status(400).json({ error: flagsResult.error });
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
        cuit: cuitNormalizado,
        condicion_fiscal,
        categoria: categoria ?? null,
        ...flagsResult.flags,
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
  const { nombre, email, cuit, condicion_fiscal, categoria, telefono } = req.body as {
    nombre?: string;
    email?: string;
    cuit?: string;
    condicion_fiscal?: string;
    categoria?: string | null;
    telefono?: string;
  };

  if (email !== undefined && !isValidEmail(email)) {
    res.status(400).json({ error: 'Email inválido' });
    return;
  }

  if (condicion_fiscal !== undefined && !isValidCondicionFiscal(condicion_fiscal)) {
    res.status(400).json({ error: 'condicion_fiscal inválida' });
    return;
  }

  let cuitNormalizado: string | null = null;
  if (cuit !== undefined) {
    cuitNormalizado = normalizeCuit(cuit);
    if (!isValidCuit(cuit) || !cuitNormalizado) {
      res.status(400).json({ error: 'CUIT inválido' });
      return;
    }
  }

  const bodyRaw = req.body as Record<string, unknown>;
  const FLAG_KEYS = ['convenio_multilateral', 'empleadores_sicoss', 'casas_particulares'] as const;

  for (const key of FLAG_KEYS) {
    if (bodyRaw[key] !== undefined && typeof bodyRaw[key] !== 'boolean') {
      res.status(400).json({ error: `${key} debe ser boolean` });
      return;
    }
  }

  const updates: Partial<Record<string, unknown>> = {};
  if (nombre !== undefined) updates.nombre = nombre;
  if (email !== undefined) updates.email = email;
  if (cuit !== undefined) updates.cuit = cuitNormalizado;
  if (condicion_fiscal !== undefined) updates.condicion_fiscal = condicion_fiscal;
  if (categoria !== undefined) updates.categoria = categoria;
  if (telefono !== undefined) updates.telefono = telefono;
  for (const key of FLAG_KEYS) {
    if (bodyRaw[key] !== undefined) updates[key] = bodyRaw[key];
  }

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

export async function cambiarPasswordCliente(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const estudio_id = req.user!.estudio_id;
  const { password } = req.body as { password?: string };

  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
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

    const password_hash = await bcrypt.hash(password, 12);

    const { error } = await supabase
      .from('users')
      .update({ password_hash })
      .eq('id', id);

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
