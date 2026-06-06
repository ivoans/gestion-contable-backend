import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  importarLibroIVA,
  crearMovimiento,
  actualizarMovimiento,
  eliminarMovimiento,
  listarMovimientos,
  resumenMovimientos,
  tendenciaMovimientos,
} from '../controllers/movimientosController';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Archivo único en memoria, límite ~5MB, solo .xlsx (por mimetype o extensión).
// Si el archivo no pasa el filtro se descarta (req.file undefined) y el handler
// responde 400 "archivo requerido".
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === XLSX_MIME || /\.xlsx$/i.test(file.originalname);
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

// CRUD de movimientos manuales (rol contador, multi-tenant por estudio_id del token).
router.post('/', authenticate, requireRole('contador'), crearMovimiento);
router.patch('/:id', authenticate, requireRole('contador'), actualizarMovimiento);
router.delete('/:id', authenticate, requireRole('contador'), eliminarMovimiento);

export default router;
