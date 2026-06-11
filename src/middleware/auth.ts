import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { getEstadoActivo } from './userStatus';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }

  const token = authHeader.split(' ')[1];

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
    return;
  }

  // Revocación: un usuario/estudio desactivado no debe seguir operando con
  // un token firmado antes de la baja (S1). Lookup en DB por request.
  const estado = await getEstadoActivo(payload.id);

  if (!estado.ok) {
    if (estado.reason === 'error_db') {
      res.status(500).json({ error: 'Error interno del servidor' });
    } else if (estado.reason === 'estudio_inactivo') {
      res.status(401).json({ error: 'Estudio desactivado' });
    } else {
      res.status(401).json({ error: 'Cuenta desactivada' });
    }
    return;
  }

  req.user = payload;
  next();
}
