import { supabase } from '../lib/supabase';

/**
 * Lookup de revocación para `authenticate`: la firma del JWT no alcanza,
 * porque desactivar un usuario/estudio debe cortar sesiones vivas (con
 * remember=true el token dura 10 días). Aislado en su propio módulo para
 * poder mockearlo en los tests de rutas sin tocar la cola del supabaseMock.
 */
export type EstadoActivo =
  | { ok: true }
  | { ok: false; reason: 'usuario_inactivo' | 'estudio_inactivo' | 'error_db' };

type UserActivoRow = {
  activo: boolean;
  estudio: { activo: boolean } | null;
};

export async function getEstadoActivo(userId: string): Promise<EstadoActivo> {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('activo, estudio:estudios!estudio_id(activo)')
      .eq('id', userId)
      .maybeSingle();

    if (error) return { ok: false, reason: 'error_db' };

    const row = data as UserActivoRow | null;

    // Usuario borrado de la DB con token vivo: revocar igual que inactivo.
    if (!row || !row.activo) return { ok: false, reason: 'usuario_inactivo' };
    if (row.estudio && !row.estudio.activo) return { ok: false, reason: 'estudio_inactivo' };

    return { ok: true };
  } catch {
    return { ok: false, reason: 'error_db' };
  }
}
