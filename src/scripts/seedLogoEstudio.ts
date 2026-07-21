import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { supabase } from '../lib/supabase';
import { subirComprobante } from '../lib/storage';

// Sube el logo del estudio (extraído del 398.pdf de Alegra) al bucket privado y setea
// estudios.logo_path para los estudios que no tengan logo. Se corre UNA vez
// (idempotente: re-subir reemplaza el objeto y el path no cambia):
//   pnpm seed-logo [ruta-al-png]
// Default: ../logo-estudio.png (raíz del monorepo, al lado del 398.pdf).
// Usa SUPABASE_URL + SUPABASE_SERVICE_KEY del .env (los mismos que usa el backend).
async function main(): Promise<void> {
  const ruta = resolve(process.argv[2] ?? resolve(__dirname, '../../../logo-estudio.png'));
  const logo = readFileSync(ruta);

  const { data, error } = await supabase.from('estudios').select('id, nombre, logo_path');
  if (error) throw new Error(`No se pudieron listar los estudios: ${error.message}`);

  for (const estudio of (data ?? []) as { id: string; nombre: string; logo_path: string | null }[]) {
    if (estudio.logo_path) {
      console.log(`- ${estudio.nombre}: ya tiene logo (${estudio.logo_path}), se saltea.`);
      continue;
    }
    const path = `${estudio.id}/branding/logo.png`;
    await subirComprobante(path, logo, 'image/png');
    const { error: updError } = await supabase
      .from('estudios')
      .update({ logo_path: path })
      .eq('id', estudio.id);
    if (updError) throw new Error(`No se pudo setear logo_path de ${estudio.nombre}: ${updError.message}`);
    console.log(`✓ ${estudio.nombre}: logo subido a ${path}`);
  }
}

main().catch((err: unknown) => {
  console.error('Error seedeando el logo:', err instanceof Error ? err.message : err);
  process.exit(1);
});
