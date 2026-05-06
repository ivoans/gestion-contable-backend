// tests/setup.ts
// Carga vía vitest setupFiles. Corre ANTES de cualquier import de código bajo test.
// No importar nada de src/ acá: queremos que el primer import del SUT vea el env ya seteado.

process.env.NODE_ENV = 'test';

// Requeridas por src/index.ts (igual saltea validación si NODE_ENV==='test', pero
// los módulos individuales (lib/supabase, emailService) leen estas en top-level).
process.env.JWT_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.CRON_SECRET = 'test-cron-secret';

// Opcionales: fijar valores deterministas.
process.env.EMAIL_FROM = 'Test <test@test.local>';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';

// Feature flag emails OFF por default. Tests que validen "se mandó email"
// pueden override con vi.stubEnv('EMAILS_ENABLED', 'true') + restore al final.
process.env.EMAILS_ENABLED = 'false';
