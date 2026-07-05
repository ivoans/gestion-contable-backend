import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { csrfProtection } from './middleware/csrf';
import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import clientesRouter from './routes/clientes';
import impuestosRouter from './routes/impuestos';
import honorariosRouter from './routes/honorarios';
import movimientosRouter from './routes/movimientos';
import vencimientosRouter from './routes/vencimientos';
import internalRouter from './routes/internal';
import configRouter from './routes/config';
import monotributoRouter from './routes/monotributo';
import pushRouter from './routes/push';
import { errorHandler } from './middleware/errorHandler';

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

  app.use(cookieParser());
  app.use(express.json());

  // CSRF (double-submit): aplica solo a mutaciones autenticadas por cookie. Debe ir
  // después de cookieParser y antes de las rutas. Ver middleware/csrf.ts.
  app.use(csrfProtection);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/clientes', clientesRouter);
  app.use('/api/impuestos', impuestosRouter);
  app.use('/api/honorarios', honorariosRouter);
  app.use('/api/movimientos', movimientosRouter);
  app.use('/api/vencimientos', vencimientosRouter);
  app.use('/api/internal', internalRouter);
  app.use('/api/config', configRouter);
  app.use('/api/monotributo', monotributoRouter);
  app.use('/api/push', pushRouter);

  // Error handler al FINAL del pipeline: convierte todo error en JSON
  // (Multer, CORS, JSON malformado, etc.). Ver middleware/errorHandler.ts.
  app.use(errorHandler);

  return app;
}
