import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getVapidPublicKey, guardarSuscripcion, borrarSuscripcion } from '../controllers/pushController';

// Sin requireRole: suscribirse es inocuo para cualquier rol. El gating de "quién
// recibe push" está en el lado emisor (hoy los crons solo mandan a clientes);
// sumar al contador después no requiere tocar estas rutas.
const router = Router();

router.get('/vapid-public-key', authenticate, getVapidPublicKey);
router.post('/subscriptions', authenticate, guardarSuscripcion);
router.delete('/subscriptions', authenticate, borrarSuscripcion);

export default router;
