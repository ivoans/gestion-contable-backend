import { Router, Request, Response } from 'express';

const router = Router();

// POST /api/admin/contadores — crear contador
router.post('/contadores', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// GET /api/admin/contadores — listar contadores del estudio
router.get('/contadores', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

// PATCH /api/admin/contadores/:id — actualizar contador (activar/desactivar, cambiar datos)
router.patch('/contadores/:id', async (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' });
});

export default router;
