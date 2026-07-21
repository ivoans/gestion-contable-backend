import { Request, Response, NextFunction } from 'express';
import { CondicionFiscal } from '../types';

/**
 * Gate por condición fiscal del usuario logueado. Va DESPUÉS de `authenticate`
 * (que carga `req.user.condicion_fiscal` desde la DB vía getEstadoActivo) y de
 * `requireRole('cliente')`. Un cliente sin condición cargada tampoco pasa.
 */
export function requireCondicionFiscal(...condiciones: CondicionFiscal[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }

    const condicion = req.user.condicion_fiscal;
    if (!condicion || !condiciones.includes(condicion)) {
      res.status(403).json({ error: 'Sin permiso para esta acción' });
      return;
    }

    next();
  };
}
