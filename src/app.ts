import express, { Express } from 'express';
import cors from 'cors';

import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import clientesRouter from './routes/clientes';
import impuestosRouter from './routes/impuestos';
import vencimientosRouter from './routes/vencimientos';
import internalRouter from './routes/internal';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [];

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origen no permitido'));
      }
    },
    credentials: true,
  }));

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/clientes', clientesRouter);
  app.use('/api/impuestos', impuestosRouter);
  app.use('/api/vencimientos', vencimientosRouter);
  app.use('/api/internal', internalRouter);

  return app;
}
