import { Router } from 'express';
import { login } from '../controllers/authController';
import { loginLimiter } from '../middleware/rateLimits';

const router = Router();

router.post('/login', loginLimiter, login);

export default router;
