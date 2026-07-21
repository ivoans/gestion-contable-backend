import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import {
  miEstadoCuenta,
  miEstadoCuentaPdf,
  estadoCuentaCliente,
  estadoCuentaPdf,
  cobranzas,
} from '../controllers/estadoCuentaController';

// /api/cuenta-corriente — estado de cuenta unificado (impuestos + honorarios).
const router = Router();

// Cliente — rutas literales antes de las paramétricas (no hay :id acá, pero mantenemos orden).
router.get('/mio', authenticate, requireRole('cliente'), miEstadoCuenta);
router.get('/mio/pdf', authenticate, requireRole('cliente'), miEstadoCuentaPdf);

// Contador — cliente_id va por query (?cliente_id=), validado en el controller.
router.get('/', authenticate, requireRole('contador'), estadoCuentaCliente);
router.get('/pdf', authenticate, requireRole('contador'), estadoCuentaPdf);

// /api/cobranzas — dashboard global de cobranzas del contador (aging por cliente).
export const cobranzasRouter = Router();
cobranzasRouter.get('/', authenticate, requireRole('contador'), cobranzas);

export default router;
