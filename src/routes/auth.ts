import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';
import { User, JwtPayload } from '../types';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    res.status(400).json({ error: 'Email y password requeridos' });
    return;
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (error || !user) {
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const typedUser = user as User & { password_hash: string };

  if (!typedUser.activo) {
    res.status(403).json({ error: 'Usuario inactivo' });
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

  const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '8h' });

  res.json({ token, user: { id: typedUser.id, nombre: typedUser.nombre, email: typedUser.email, role: typedUser.role } });
});

export default router;
