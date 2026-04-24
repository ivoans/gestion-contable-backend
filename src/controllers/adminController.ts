import { Request, Response } from 'express';

export async function crearContador(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function listarContadores(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function actualizarContador(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}
