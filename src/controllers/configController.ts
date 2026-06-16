import { Request, Response } from 'express';
import { supabase } from '../lib/supabase';

// GET /api/config — config del estudio del usuario logueado (cualquier rol). Hoy solo
// expone si la subida de comprobantes está habilitada, para que el front muestre o
// esconda la UI correspondiente. La autorización real igual la hace el backend.
export async function getConfig(req: Request, res: Response): Promise<void> {
  const estudio_id = req.user!.estudio_id;

  try {
    const { data, error } = await supabase
      .from('estudios')
      .select('comprobantes_habilitados')
      .eq('id', estudio_id)
      .maybeSingle();

    if (error) {
      res.status(500).json({ error: 'Error interno del servidor' });
      return;
    }

    res.json({
      comprobantes_habilitados:
        (data as { comprobantes_habilitados?: boolean } | null)?.comprobantes_habilitados === true,
    });
  } catch {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
