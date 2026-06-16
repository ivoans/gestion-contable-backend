import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';
import { User, JwtPayload } from '../types';
import { isValidEmail } from '../utils/validators';
import { setAuthCookies, clearAuthCookies, generateCsrfToken } from '../lib/cookies';

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

    // Sesión por cookie httpOnly + cookie csrf legible (double-submit). El body sigue
    // devolviendo token/expires_at por compatibilidad durante la transición; el front
    // nuevo los ignora y usa la cookie.
    const csrf = generateCsrfToken();
    setAuthCookies(res, token, csrf, remember === true);

    res.json({
      token,
      expires_at,
      user: userData,
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// GET /api/auth/me — rehidrata la sesión del front (que no puede leer el token httpOnly).
// Devuelve el user fresco de la DB con el mismo shape que /login.
export async function me(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    if (!data) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }

    const { password_hash: _password_hash, ...userData } = data as User & {
      password_hash: string;
    };

    res.json({ user: userData });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// POST /api/auth/logout — borra las cookies de sesión. Idempotente; no requiere token válido.
export function logout(_req: Request, res: Response): void {
  clearAuthCookies(res);
  res.json({ ok: true });
}
