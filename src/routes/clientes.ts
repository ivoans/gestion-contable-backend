import { Router, Request, Response } from 'express';

const router = Router();

// GET /api/clientes — listar clientes del estudio
router.get('/', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// POST /api/clientes — crear cliente
router.post('/', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// GET /api/clientes/:id — obtener cliente por id
router.get('/:id', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// PATCH /api/clientes/:id — actualizar cliente
router.patch('/:id', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

export default router;
