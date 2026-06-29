import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { requireUuidParams } from '../middleware/validateUuid';
import {
  crearImpuesto,
  generarImpuestos,
  listarImpuestos,
  obtenerImpuesto,
  actualizarImpuesto,
  cambiarEstadoImpuesto,
  revertirImpuesto,
  misImpuestos,
  miImpuesto,
  pagarMiImpuesto,
} from '../controllers/impuestosController';
import {
  subirMiComprobante,
  miComprobante,
  comprobanteDeImpuesto,
} from '../controllers/comprobantesController';

// Comprobante en memoria, límite ~8MB (la imagen se recomprime después con sharp). El
// mime real se valida en el controller para dar mensajes claros.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const router = Router();

// Cliente routes — registered before /:id to avoid route conflict
router.get('/mis-impuestos', authenticate, requireRole('cliente'), misImpuestos);
router.get('/mis-impuestos/:id', authenticate, requireRole('cliente'), requireUuidParams('id'), miImpuesto);
router.patch(
  '/mis-impuestos/:id/estado',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  pagarMiImpuesto,
);
router.get(
  '/mis-impuestos/:id/comprobante',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  miComprobante,
);
router.post(
  '/mis-impuestos/:id/comprobante',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  upload.single('archivo'),
  subirMiComprobante,
);

// Contador routes
router.post('/generar', authenticate, requireRole('contador'), generarImpuestos);
router.post('/', authenticate, requireRole('contador'), crearImpuesto);
router.get('/', authenticate, requireRole('contador'), listarImpuestos);
router.get('/:id', authenticate, requireRole('contador'), requireUuidParams('id'), obtenerImpuesto);
router.get(
  '/:id/comprobante',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  comprobanteDeImpuesto,
);
router.patch('/:id', authenticate, requireRole('contador'), requireUuidParams('id'), actualizarImpuesto);
router.patch(
  '/:id/estado',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  cambiarEstadoImpuesto,
);
router.patch(
  '/:id/revertir',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  revertirImpuesto,
);

export default router;
