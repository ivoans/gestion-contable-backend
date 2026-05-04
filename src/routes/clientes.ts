import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  listarClientes,
  crearCliente,
  obtenerCliente,
  actualizarCliente,
  actualizarEstadoCliente,
} from '../controllers/clientesController';

const router = Router();

router.use(authenticate, requireRole('contador'));

router.get('/', listarClientes);
router.post('/', crearCliente);
router.get('/:id', obtenerCliente);
router.patch('/:id', actualizarCliente);
router.patch('/:id/estado', actualizarEstadoCliente);

export default router;
