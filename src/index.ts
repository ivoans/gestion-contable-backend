import 'dotenv/config';

const REQUIRED_ENV = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESEND_API_KEY'] as const;

if (process.env.NODE_ENV !== 'test') {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Variable de entorno requerida no definida: ${key}`);
    }
  }
}

import { createApp } from './app';
import { initCronJobs } from './jobs/vencimientosCron';
import { initHonorariosJobs } from './jobs/honorariosCron';

// M5: UN solo mecanismo de cron. 'internal' = node-cron in-process (default);
// 'external' = un scheduler externo dispara POST /api/internal/run-cron.
// Configurar ambos a la vez causaría doble procesamiento el mismo día.
const CRON_SCHEDULER = process.env.CRON_SCHEDULER ?? 'internal';

if (CRON_SCHEDULER !== 'internal' && CRON_SCHEDULER !== 'external') {
  throw new Error(`CRON_SCHEDULER debe ser 'internal' o 'external' (recibido: '${CRON_SCHEDULER}')`);
}

const app = createApp();
const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  if (CRON_SCHEDULER === 'internal') {
    initCronJobs();
    initHonorariosJobs();
  } else {
    console.log('[cron] Scheduler interno deshabilitado (CRON_SCHEDULER=external) — disparar con POST /api/internal/run-cron');
  }
});
