import { supabase } from '../lib/supabase';
import { CondicionFiscal } from '../types';

/**
 * Lookup de revocación para `authenticate`: la firma del JWT no alcanza,
 * porque desactivar un usuario/estudio debe cortar sesiones vivas (con
 * remember=true el token dura 10 días). Aislado en su propio módulo para
 * poder mockearlo en los tests de rutas sin tocar la cola del supabaseMock.
 *
 * De paso trae `condicion_fiscal` (misma query, sin round-trip extra): la
 * necesitan los gates por condición (p. ej. Libro IVA solo para responsables
 * inscriptos) y el JWT no la lleva porque puede cambiar durante la sesión.
 */
export type EstadoActivo =
  | { ok: true; condicion_fiscal?: CondicionFiscal | null }
  | { ok: false; reason: 'usuario_inactivo' | 'estudio_inactivo' | 'error_db' };

type UserActivoRow = {
  activo: boolean;
  condicion_fiscal: CondicionFiscal | null;
  estudio: { activo: boolean } | null;
};

export async function getEstadoActivo(userId: string): Promise<EstadoActivo> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('activo, condicion_fiscal, estudio:estudios!estudio_id(activo)')
      .eq('id', userId)
      .maybeSingle();

    if (error) return { ok: false, reason: 'error_db' };

    const row = data as UserActivoRow | null;

    // Usuario borrado de la DB con token vivo: revocar igual que inactivo.
    if (!row || !row.activo) return { ok: false, reason: 'usuario_inactivo' };
    if (row.estudio && !row.estudio.activo) return { ok: false, reason: 'estudio_inactivo' };

    return { ok: true, condicion_fiscal: row.condicion_fiscal };
  } catch {
    return { ok: false, reason: 'error_db' };
  }
}
