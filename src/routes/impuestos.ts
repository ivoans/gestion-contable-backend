import { Router, Request, Response } from 'express';

const router = Router();

// GET /api/impuestos — listar impuestos (filtrados por rol)
router.get('/', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// POST /api/impuestos — crear impuesto
router.post('/', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// GET /api/impuestos/:id — obtener impuesto por id
router.get('/:id', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// PATCH /api/impuestos/:id/estado — cambiar estado (pendiente → pagado)
router.patch('/:id/estado', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

export default router;
