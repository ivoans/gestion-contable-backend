import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  crearContador,
  listarContadores,
  obtenerContador,
  actualizarContador,
  actualizarEstadoContador,
  listarEstudios,
} from '../controllers/adminController';

const router = Router();

router.use(authenticate, requireRole('admin'));

router.post('/contadores', crearContador);
router.get('/contadores', listarContadores);
router.get('/contadores/:id', obtenerContador);
router.patch('/contadores/:id/estado', actualizarEstadoContador);
router.patch('/contadores/:id', actualizarContador);

router.get('/estudios', listarEstudios);

export default router;
