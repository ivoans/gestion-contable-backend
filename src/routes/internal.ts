import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import {
  procesarVencidos,
  procesarRecordatorios,
  notificarGeneracionDigest,
} from '../jobs/vencimientosCron';
import {
  procesarHonorariosVencidos,
  notificarHonorariosNuevos,
  procesarHonorariosRecordatorios,
  generarHonorariosMesActual,
} from '../jobs/honorariosCron';

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

type Job =
  | 'vencidos'
  | 'recordatorios'
  | 'generacion_digest'
  | 'honorarios_vencidos'
  | 'honorarios_nuevos'
  | 'honorarios_recordatorios'
  | 'honorarios_generar'
  | 'all';

const JOBS: Job[] = [
  'vencidos',
  'recordatorios',
  'generacion_digest',
  'honorarios_vencidos',
  'honorarios_nuevos',
  'honorarios_recordatorios',
  'honorarios_generar',
  'all',
];

router.post('/run-cron', requireCronSecret, async (req: Request, res: Response): Promise<void> => {
  const { job } = (req.body ?? {}) as { job?: Job };
  const target: Job = job ?? 'all';

  if (!JOBS.includes(target)) {
    res.status(400).json({ error: `job inválido; opciones: ${JOBS.join(', ')}` });
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
    if (target === 'generacion_digest' || target === 'all') {
      await notificarGeneracionDigest();
      ran.push('generacion_digest');
    }
    // Generación mensual: idempotente, seguro correrla en cada 'all' (solo crea el mes actual una vez).
    if (target === 'honorarios_generar' || target === 'all') {
      await generarHonorariosMesActual();
      ran.push('honorarios_generar');
    }
    if (target === 'honorarios_vencidos' || target === 'all') {
      await procesarHonorariosVencidos();
      ran.push('honorarios_vencidos');
    }
    if (target === 'honorarios_nuevos' || target === 'all') {
      await notificarHonorariosNuevos();
      ran.push('honorarios_nuevos');
    }
    if (target === 'honorarios_recordatorios' || target === 'all') {
      await procesarHonorariosRecordatorios();
      ran.push('honorarios_recordatorios');
    }
    res.json({ status: 'ok', ran });
  } catch (err) {
    console.error('[internal:run-cron] Error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
