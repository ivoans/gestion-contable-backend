import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  crearImpuesto,
  listarImpuestos,
  obtenerImpuesto,
  actualizarImpuesto,
  cambiarEstadoImpuesto,
  misImpuestos,
  miImpuesto,
} from '../controllers/impuestosController';

const router = Router();

// Cliente routes — registered before /:id to avoid route conflict
router.get('/mis-impuestos', authenticate, requireRole('cliente'), misImpuestos);
router.get('/mis-impuestos/:id', authenticate, requireRole('cliente'), miImpuesto);

// Contador routes
router.post('/', authenticate, requireRole('contador'), crearImpuesto);
router.get('/', authenticate, requireRole('contador'), listarImpuestos);
router.get('/:id', authenticate, requireRole('contador'), obtenerImpuesto);
router.patch('/:id', authenticate, requireRole('contador'), actualizarImpuesto);
router.patch('/:id/estado', authenticate, requireRole('contador'), cambiarEstadoImpuesto);

export default router;
