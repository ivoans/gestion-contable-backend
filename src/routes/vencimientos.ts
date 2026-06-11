import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  listarVencimientos,
  reemplazarVencimientosAnio,
  eliminarVencimiento,
} from '../controllers/vencimientosController';

const router = Router();

router.get('/', authenticate, requireRole('contador'), listarVencimientos);
router.put('/', authenticate, requireRole('contador'), reemplazarVencimientosAnio);
router.delete('/:id', authenticate, requireRole('contador'), eliminarVencimiento);

export default router;
