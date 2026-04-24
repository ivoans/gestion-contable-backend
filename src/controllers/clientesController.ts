import { Request, Response } from 'express';

export async function listarClientes(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function crearCliente(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function obtenerCliente(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}

export async function actualizarCliente(_req: Request, res: Response): Promise<void> {
  res.status(501).json({ error: 'Not implemented' });
}
