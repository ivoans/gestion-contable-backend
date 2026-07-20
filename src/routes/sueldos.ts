import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { requireUuidParams } from '../middleware/validateUuid';
import {
  crearSueldo,
  listarSueldos,
  actualizarSueldo,
  borrarSueldo,
  archivoSueldo,
  misSueldos,
  miArchivoSueldo,
} from '../controllers/sueldosController';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const router = Router();

// Cliente (solo lectura) — registrar antes de las rutas del contador para no colisionar.
router.get('/mios', authenticate, requireRole('cliente'), misSueldos);
router.get(
  '/mis-sueldos/:id/archivo',
  authenticate,
  requireRole('cliente'),
  requireUuidParams('id'),
  miArchivoSueldo,
);

// Contador — CRUD. Rutas literales antes de las paramétricas.
router.get('/', authenticate, requireRole('contador'), listarSueldos);
router.post('/', authenticate, requireRole('contador'), upload.single('archivo'), crearSueldo);
router.get(
  '/:id/archivo',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  archivoSueldo,
);
router.patch(
  '/:id',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  upload.single('archivo'),
  actualizarSueldo,
);
router.delete(
  '/:id',
  authenticate,
  requireRole('contador'),
  requireUuidParams('id'),
  borrarSueldo,
);

export default router;
