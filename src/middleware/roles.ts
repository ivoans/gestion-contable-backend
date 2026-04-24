import { Request, Response, NextFunction } from 'express';
import { Role } from '../types';

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Sin permiso para esta acción' });
      return;
    }

    next();
  };
}
