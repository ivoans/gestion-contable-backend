import { Request, Response } from 'express';

export async function listarImpuestos(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function crearImpuesto(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function obtenerImpuesto(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function cambiarEstadoImpuesto(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}
