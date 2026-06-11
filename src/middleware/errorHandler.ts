import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';

/**
 * Error handler global: garantiza que TODO error que llegue al final del
 * pipeline salga como JSON (nunca el HTML default de Express, que en
 * NODE_ENV ≠ production incluye stack trace).
 *
 * Casos mapeados:
 * - MulterError (p. ej. LIMIT_FILE_SIZE con archivo >5MB) → 400
 * - Rechazo de CORS (origin fuera de ALLOWED_ORIGINS)     → 403
 * - Body malformado en express.json()                     → 400
 * - Body que excede el límite de express.json()           → 413
 * - Resto                                                 → 500 genérico
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  // Si ya se empezó a escribir la respuesta, delegar al default de Express
  // (que cierra la conexión); no se puede cambiar status/body a esta altura.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'El archivo supera el tamaño máximo permitido (5MB)'
      : `Error al procesar el archivo: ${err.code}`;
    res.status(400).json({ error: msg });
    return;
  }

  const e = err as { message?: string; type?: string; status?: number };

  if (e?.message === 'CORS: origen no permitido') {
    res.status(403).json({ error: 'CORS: origen no permitido' });
    return;
  }

  // Errores de body-parser (express.json): type los identifica sin depender del message.
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON malformado en el body' });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Body demasiado grande' });
    return;
  }

  console.error('[errorHandler] Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}
