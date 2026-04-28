import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const REQUIRED_ENV = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESEND_API_KEY'] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Variable de entorno requerida no definida: ${key}`);
  }
}

import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import clientesRouter from './routes/clientes';
import impuestosRouter from './routes/impuestos';
import { initCronJobs } from './jobs/vencimientosCron';

const app = express();
const PORT = process.env.PORT ?? 3000;

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

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  initCronJobs();
});
