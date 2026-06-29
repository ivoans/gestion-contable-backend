import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { requireUuidParams } from '../middleware/validateUuid';
import {
  crearContador,
  listarContadores,
  obtenerContador,
  actualizarContador,
  actualizarEstadoContador,
  listarEstudios,
  actualizarComprobantesEstudio,
} from '../controllers/adminController';

const router = Router();

router.use(authenticate, requireRole('admin'));

router.post('/contadores', crearContador);
router.get('/contadores', listarContadores);
router.get('/contadores/:id', requireUuidParams('id'), obtenerContador);
router.patch('/contadores/:id/estado', requireUuidParams('id'), actualizarEstadoContador);
router.patch('/contadores/:id', requireUuidParams('id'), actualizarContador);

router.get('/estudios', listarEstudios);
router.patch('/estudios/:id/comprobantes', requireUuidParams('id'), actualizarComprobantesEstudio);

export default router;
