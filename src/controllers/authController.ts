import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';
import { User, JwtPayload } from '../types';
import { isValidEmail } from '../utils/validators';

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password, remember } = req.body as {
    email: string;
    password: string;
    remember?: boolean;
  };

  if (!email || !password) {
    res.status(400).json({ error: 'Email y password requeridos' });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Email inválido' });
    return;
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!user) {
      res.status(401).json({ error: 'Credenciales inválidas' });
      return;
    }

    const typedUser = user as User & { password_hash: string };

    if (!typedUser.activo) {
      res.status(401).json({ error: 'Credenciales inválidas' });
      return;
    }

    const valid = await bcrypt.compare(password, typedUser.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Credenciales inválidas' });
      return;
    }

    const payload: JwtPayload = {
      id: typedUser.id,
      email: typedUser.email,
      role: typedUser.role,
      estudio_id: typedUser.estudio_id,
    };

    const expiresIn = remember === true ? '10d' : '8h';
    const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn });

    const decoded = jwt.decode(token) as { exp: number };
    const expires_at = new Date(decoded.exp * 1000).toISOString();

    const { password_hash: _password_hash, ...userData } = typedUser;

    res.json({
      token,
      expires_at,
      user: userData,
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
