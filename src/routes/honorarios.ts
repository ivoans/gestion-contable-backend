import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { requireUuidParams } from '../middleware/validateUuid';
import {
  listarHonorarios,
  resumenHonorarios,
  generarHonorariosEndpoint,
  crearHonorario,
  crearHonorariosRetroactivos,
  actualizarHonorario,
  cambiarEstadoHonorario,
  revertirHonorario,
  anularHonorario,
  listarPlanes,
  upsertPlan,
  misHonorarios,
  pagarMiHonorario,
} from '../controllers/honorariosController';
import {
  subirMiComprobanteHonorario,
  miComprobanteHonorario,
  comprobanteDeHonorario,
} from '../controllers/comprobantesController';
import { emitirRecibo, reciboDeHonorario, miRecibo } from '../controllers/recibosController';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const router = Router();

// Cliente — registrar antes de /:id para no colisionar.
router.get('/mis-honorarios', authenticate, requireRole('cliente'), misHonorarios);
router.patch(
  '/mis-honorarios/:id/estado',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  pagarMiHonorario,
);
router.get(
  '/mis-honorarios/:id/comprobante',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  miComprobanteHonorario,
);
router.post(
  '/mis-honorarios/:id/comprobante',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  upload.single('archivo'),
  subirMiComprobanteHonorario,
);
router.get(
  '/mis-honorarios/:id/recibo',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  miRecibo,
);

// Contador — rutas literales antes de las paramétricas.
router.get('/planes', authenticate, requireRole('contador'), listarPlanes);
router.put(
  '/planes/:clienteId',
  authenticate,
  requireRole('contador'),
  requireUuidParams('clienteId'),
  upsertPlan,
);
router.post('/generar', authenticate, requireRole('contador'), generarHonorariosEndpoint);
router.post('/retroactivos', authenticate, requireRole('contador'), crearHonorariosRetroactivos);
router.get('/resumen', authenticate, requireRole('contador'), resumenHonorarios);
router.get('/', authenticate, requireRole('contador'), listarHonorarios);
router.post('/', authenticate, requireRole('contador'), crearHonorario);
router.post(
  '/:id/recibo',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  emitirRecibo,
);
router.get(
  '/:id/recibo',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  reciboDeHonorario,
);
router.get(
  '/:id/comprobante',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  comprobanteDeHonorario,
);
router.patch(
  '/:id/estado',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  cambiarEstadoHonorario,
);
router.patch(
  '/:id/revertir',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  revertirHonorario,
);
router.patch(
  '/:id/anular',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  anularHonorario,
);
router.patch('/:id', authenticate, requireRole('contador'), requireUuidParams('id'), actualizarHonorario);

export default router;
