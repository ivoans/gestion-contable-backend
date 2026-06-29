import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { requireUuidParams } from '../middleware/validateUuid';
import {
  listarClientes,
  crearCliente,
  obtenerCliente,
  actualizarCliente,
  actualizarEstadoCliente,
  cambiarPasswordCliente,
} from '../controllers/clientesController';

const router = Router();

router.use(authenticate, requireRole('contador'));

router.get('/', listarClientes);
router.post('/', crearCliente);
router.get('/:id', requireUuidParams('id'), obtenerCliente);
router.patch('/:id', requireUuidParams('id'), actualizarCliente);
router.patch('/:id/estado', requireUuidParams('id'), actualizarEstadoCliente);
router.patch('/:id/password', requireUuidParams('id'), cambiarPasswordCliente);

export default router;
