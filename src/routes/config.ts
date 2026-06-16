import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getConfig } from '../controllers/configController';

const router = Router();

router.get('/', authenticate, getConfig);

export default router;
