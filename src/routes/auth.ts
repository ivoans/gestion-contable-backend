import { Router } from 'express';
import { login, me, logout } from '../controllers/authController';
import { loginLimiter } from '../middleware/rateLimits';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/login', loginLimiter, login);
router.get('/me', authenticate, me);
router.post('/logout', logout);

export default router;
