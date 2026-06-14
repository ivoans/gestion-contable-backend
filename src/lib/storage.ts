import { supabase } from './supabase';

// Bucket PRIVADO donde viven los comprobantes de pago. Privado = no hay URL pública;
// se accede solo con signed URLs de corta vida que genera el backend. El bucket se
// crea una vez con `pnpm ensure-bucket` (script) o desde el dashboard de Supabase.
export const COMPROBANTES_BUCKET = 'comprobantes';

// Vida de las signed URLs que se devuelven al front para mostrar/descargar (segundos).
export const SIGNED_URL_TTL = 60 * 10; // 10 min

/**
 * Crea el bucket privado si no existe (idempotente). Lo usa el script de setup; el
 * flujo normal asume que ya existe.
 */
export async function ensureComprobantesBucket(): Promise<void> {
  const { data, error } = await supabase.storage.getBucket(COMPROBANTES_BUCKET);
  if (data && !error) return;
  const { error: createError } = await supabase.storage.createBucket(COMPROBANTES_BUCKET, {
    public: false,
  });
  // Si otro proceso lo creó en el medio, ignoramos el "ya existe".
  if (createError && !/already exists/i.test(createError.message)) {
    throw createError;
  }
}

/** Sube (o reemplaza) un objeto en el bucket de comprobantes. */
export async function subirComprobante(
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(COMPROBANTES_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
}

/** Genera una signed URL de corta vida para ver/descargar un objeto. */
export async function signedUrlComprobante(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(COMPROBANTES_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Borra un objeto (best-effort; usado al reemplazar un comprobante). */
export async function borrarComprobante(path: string): Promise<void> {
  await supabase.storage.from(COMPROBANTES_BUCKET).remove([path]);
}
