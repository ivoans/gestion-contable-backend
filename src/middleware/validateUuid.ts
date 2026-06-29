import { Request, Response, NextFunction } from 'express';
import { isValidUuid } from '../utils/validators';

/**
 * Middleware que valida que los params de ruta indicados sean UUID.
 * Un id no-UUID se corta acá con 400 en vez de viajar a PostgREST (error `22P02`)
 * y devolver un 500 genérico que ensucia el monitoreo. Aplicar después de
 * `authenticate`/`requireRole` y antes del controller.
 */
export function requireUuidParams(...names: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const name of names) {
      const value = req.params[name];
      if (value !== undefined && !isValidUuid(value)) {
        res.status(400).json({ error: `${name} debe ser un uuid válido` });
        return;
      }
    }
    next();
  };
}
