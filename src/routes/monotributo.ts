import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  getEscala,
  upsertEscala,
  importarFacturacion,
  getFacturacionCliente,
  getResumenCliente,
  getMio,
  getMisComprobantes,
  getComprobantesCliente,
} from '../controllers/monotributoController';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIMES_ACEPTADOS = new Set([
  XLSX_MIME,
  'application/vnd.ms-excel',
  'application/xml',
  'text/xml',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = MIMES_ACEPTADOS.has(file.mimetype) || /\.xlsx?$/i.test(file.originalname);
    cb(null, ok);
  },
});

const router = Router();

// Cliente — su propia facturación + posición vs escala (sin exponer la tabla de escala).
router.get('/mio', authenticate, requireRole('cliente'), getMio);
// Cliente — su detalle de comprobantes de un período (vista tipo Libro IVA).
router.get('/mio/comprobantes', authenticate, requireRole('cliente'), getMisComprobantes);

// Escala (contador/admin) — la edita por estudio.
router.get('/escala', authenticate, requireRole('contador', 'admin'), getEscala);
router.put('/escala', authenticate, requireRole('contador'), upsertEscala);

// Facturación (contador) — import del export AFIP por cliente + vista de verificación.
router.post(
  '/facturacion/import',
  authenticate,
  requireRole('contador'),
  upload.single('archivo'),
  importarFacturacion,
);
router.get('/facturacion', authenticate, requireRole('contador'), getFacturacionCliente);

// Resumen de un cliente (serie 12m + posición), para la vista del contador.
router.get('/resumen', authenticate, requireRole('contador'), getResumenCliente);
// Detalle de comprobantes de un cliente/período, para la vista del contador.
router.get('/comprobantes', authenticate, requireRole('contador'), getComprobantesCliente);

export default router;
