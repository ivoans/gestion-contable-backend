import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  listarHonorarios,
  resumenHonorarios,
  generarHonorariosEndpoint,
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const router = Router();

// Cliente — registrar antes de /:id para no colisionar.
router.get('/mis-honorarios', authenticate, requireRole('cliente'), misHonorarios);
router.patch('/mis-honorarios/:id/estado', authenticate, requireRole('cliente'), pagarMiHonorario);
router.get(
  '/mis-honorarios/:id/comprobante',
  authenticate,
  requireRole('cliente'),
  miComprobanteHonorario,
);
router.post(
  '/mis-honorarios/:id/comprobante',
  authenticate,
  requireRole('cliente'),
  upload.single('archivo'),
  subirMiComprobanteHonorario,
);

// Contador — rutas literales antes de las paramétricas.
router.get('/planes', authenticate, requireRole('contador'), listarPlanes);
router.put('/planes/:clienteId', authenticate, requireRole('contador'), upsertPlan);
router.post('/generar', authenticate, requireRole('contador'), generarHonorariosEndpoint);
router.get('/resumen', authenticate, requireRole('contador'), resumenHonorarios);
router.get('/', authenticate, requireRole('contador'), listarHonorarios);
router.get('/:id/comprobante', authenticate, requireRole('contador'), comprobanteDeHonorario);
router.patch('/:id/estado', authenticate, requireRole('contador'), cambiarEstadoHonorario);
router.patch('/:id/revertir', authenticate, requireRole('contador'), revertirHonorario);
router.patch('/:id/anular', authenticate, requireRole('contador'), anularHonorario);
router.patch('/:id', authenticate, requireRole('contador'), actualizarHonorario);

export default router;
