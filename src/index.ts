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

const app = createApp();
const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  initCronJobs();
});
