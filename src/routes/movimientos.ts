import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { requireUuidParams } from '../middleware/validateUuid';
import {
  importarLibroIVA,
  crearMovimiento,
  actualizarMovimiento,
  eliminarMovimiento,
  listarMovimientos,
  resumenMovimientos,
  tendenciaMovimientos,
  listarMisMovimientos,
  resumenMisMovimientos,
  tendenciaMisMovimientos,
} from '../controllers/movimientosController';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Algunos software contables exportan el libro como Excel 2003 (.xls), que llega como
// binario BIFF o como SpreadsheetML/XML. SheetJS lee todos. Se acepta .xlsx y .xls por
// extensión o por cualquiera de estos mimetypes; lo que pase igual se valida al parsear.
const MIMES_ACEPTADOS = new Set([
  XLSX_MIME,
  'application/vnd.ms-excel',
  'application/xml',
  'text/xml',
]);

// Archivo único en memoria, límite ~5MB, .xlsx o .xls (por mimetype o extensión).
// Si el archivo no pasa el filtro se descarta (req.file undefined) y el handler
// responde 400 "archivo requerido".
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = MIMES_ACEPTADOS.has(file.mimetype) || /\.xlsx?$/i.test(file.originalname);
    cb(null, ok);
  },
});

const router = Router();

router.post(
  '/importar',
  authenticate,
  requireRole('contador'),
  upload.single('archivo'),
  importarLibroIVA,
);

// Lectura del libro de un cliente por período (rol contador). /resumen antes que
// el listado por prolijidad; ambos son literales y no colisionan.
router.get('/resumen', authenticate, requireRole('contador'), resumenMovimientos);
router.get('/tendencia', authenticate, requireRole('contador'), tendenciaMovimientos);
router.get('/', authenticate, requireRole('contador'), listarMovimientos);

// Lectura del PROPIO libro (rol cliente). cliente_id sale del token, no de la query.
// Rutas estáticas /mis-movimientos/... declaradas antes que el /:id de abajo para
// que ningún segmento se confunda con un parámetro. /resumen y /tendencia antes que
// el listado por prolijidad; todos son literales y no colisionan.
router.get('/mis-movimientos/resumen', authenticate, requireRole('cliente'), resumenMisMovimientos);
router.get('/mis-movimientos/tendencia', authenticate, requireRole('cliente'), tendenciaMisMovimientos);
router.get('/mis-movimientos', authenticate, requireRole('cliente'), listarMisMovimientos);

// CRUD de movimientos manuales (rol contador, multi-tenant por estudio_id del token).
router.post('/', authenticate, requireRole('contador'), crearMovimiento);
router.patch('/:id', authenticate, requireRole('contador'), requireUuidParams('id'), actualizarMovimiento);
router.delete('/:id', authenticate, requireRole('contador'), requireUuidParams('id'), eliminarMovimiento);

export default router;
