import 'dotenv/config';
import { ensureComprobantesBucket, COMPROBANTES_BUCKET } from '../lib/storage';

// Crea el bucket privado de comprobantes si no existe. Se corre UNA vez (idempotente):
//   pnpm ensure-bucket
// Usa SUPABASE_URL + SUPABASE_SERVICE_KEY del .env (los mismos que usa el backend).
async function main(): Promise<void> {
  await ensureComprobantesBucket();
  console.log(`✓ Bucket privado '${COMPROBANTES_BUCKET}' listo.`);
}

main().catch((err: unknown) => {
  console.error('Error creando el bucket:', err instanceof Error ? err.message : err);
  process.exit(1);
});
