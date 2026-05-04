import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { procesarVencidos, procesarRecordatorios } from '../jobs/vencimientosCron';

const router = Router();

function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    res.status(503).json({ error: 'CRON_SECRET no configurado' });
    return;
  }

  const provided = req.header('x-cron-secret');

  if (!provided) {
    res.status(401).json({ error: 'Header x-cron-secret requerido' });
    return;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'Secret inválido' });
    return;
  }

  next();
}

type Job = 'vencidos' | 'recordatorios' | 'all';

router.post('/run-cron', requireCronSecret, async (req: Request, res: Response): Promise<void> => {
  const { job } = (req.body ?? {}) as { job?: Job };
  const target: Job = job ?? 'all';

  if (target !== 'vencidos' && target !== 'recordatorios' && target !== 'all') {
    res.status(400).json({ error: "job debe ser 'vencidos', 'recordatorios' o 'all'" });
    return;
  }

  try {
    const ran: string[] = [];
    if (target === 'vencidos' || target === 'all') {
      await procesarVencidos();
      ran.push('vencidos');
    }
    if (target === 'recordatorios' || target === 'all') {
      await procesarRecordatorios();
      ran.push('recordatorios');
    }
    res.json({ status: 'ok', ran });
  } catch (err) {
    console.error('[internal:run-cron] Error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
