import sharp from 'sharp';

// Procesamiento común de archivos subidos (comprobantes, recibos de sueldo, etc.):
// las imágenes se recomprimen a JPEG; el PDF va tal cual. Mismos parámetros que
// `comprobantesController` para que una foto de celular baje a ~150-300KB (Storage gratis).
export const MIMES_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MIME_PDF = 'application/pdf';

const MAX_LADO = 1600;
const JPEG_QUALITY = 72;

// Procesa el archivo subido. Devuelve null si el mime no es aceptado (imagen o PDF).
export async function procesarArchivo(
  file: Express.Multer.File,
): Promise<{ buffer: Buffer; mime: string; ext: string } | null> {
  const mimeOriginal = file.mimetype;
  if (MIMES_IMAGEN.has(mimeOriginal)) {
    const buffer = await sharp(file.buffer)
      .rotate() // respeta la orientación EXIF de las fotos de celular
      .resize({ width: MAX_LADO, height: MAX_LADO, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { buffer, mime: 'image/jpeg', ext: 'jpg' };
  }
  if (mimeOriginal === MIME_PDF) {
    return { buffer: file.buffer, mime: MIME_PDF, ext: 'pdf' };
  }
  return null;
}
