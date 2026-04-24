import { Router } from 'express';
import {
  listarClientes,
  crearCliente,
  obtenerCliente,
  actualizarCliente,
} from '../controllers/clientesController';

const router = Router();

router.get('/', listarClientes);
router.post('/', crearCliente);
router.get('/:id', obtenerCliente);
router.patch('/:id', actualizarCliente);

export default router;
