import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import clientesRouter from './routes/clientes';
import impuestosRouter from './routes/impuestos';
import { initCronJobs } from './jobs/vencimientosCron';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
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
