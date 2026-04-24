import { Router } from 'express';
import {
  crearContador,
  listarContadores,
  actualizarContador,
} from '../controllers/adminController';

const router = Router();

router.post('/contadores', crearContador);
router.get('/contadores', listarContadores);
router.patch('/contadores/:id', actualizarContador);

export default router;
