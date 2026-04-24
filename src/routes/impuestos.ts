import { Router } from 'express';
import {
  listarImpuestos,
  crearImpuesto,
  obtenerImpuesto,
  cambiarEstadoImpuesto,
} from '../controllers/impuestosController';

const router = Router();

router.get('/', listarImpuestos);
router.post('/', crearImpuesto);
router.get('/:id', obtenerImpuesto);
router.patch('/:id/estado', cambiarEstadoImpuesto);

export default router;
