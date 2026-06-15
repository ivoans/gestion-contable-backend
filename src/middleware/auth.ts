import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { getEstadoActivo } from './userStatus';
import { TOKEN_COOKIE } from '../lib/cookies';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Token desde la cookie httpOnly (preferido). Fallback al header Authorization: Bearer
  // para clientes no-browser y para la transición desde el esquema viejo (localStorage).
  const cookieToken = req.cookies?.[TOKEN_COOKIE] as string | undefined;
  const authHeader = req.headers.authorization;
  const headerToken =
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
  const token = cookieToken ?? headerToken;

  if (!token) {
    res.status(401).json({ error: 'Token requerido' });
    return;
  }

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
