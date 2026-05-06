# Tests — gestion-contable-backend

Suite Vitest + Supertest. Mocks unitarios para Supabase, Resend, bcrypt. JWT real firmado con secret de test. **104 tests pasando** al momento de redactar.

```bash
pnpm test            # corre suite
pnpm test:watch      # modo watch
pnpm test:cov        # con coverage v8
```

---

## Stack y patrones

| Tema | Decisión |
|------|----------|
| Runner | Vitest 4 |
| HTTP | Supertest sobre `createApp()` (sin `listen`) |
| DB | `vi.mock('../src/lib/supabase')` con helper chainable `createSupabaseMock()` |
| bcrypt | `vi.mock('bcryptjs')` con `compare`/`hash` controlados |
| JWT | **real**, firmado con `JWT_SECRET=test-secret` (verificación end-to-end del middleware) |
| Resend | `vi.mock('../src/services/emailService')` por test (skip cuando no aplica) |
| Rate limit | `vi.mock('../src/middleware/rateLimits')` con pass-through (no testeamos la lib) |
| Aislamiento | `pool: 'forks'` + `isolate: true` → un worker por archivo |

### Patrón de hoist obligatorio

`vi.mock` se hoistea a la cima del archivo. Si la factory referencia `sb` declarado en module-scope, falla con TDZ porque los `import` de SUT también están hoisteados arriba. Solución: `vi.hoisted` con `await` + dynamic import (`require` síncrono **no** resuelve `.ts` en Vite).

```ts
const { sb, bcryptMock } = await vi.hoisted(async () => {
  const { createSupabaseMock } = await import('./helpers/supabaseMock');
  return { sb: createSupabaseMock(), bcryptMock: { compare: vi.fn(), hash: vi.fn() } };
});

vi.mock('../src/lib/supabase', () => ({ supabase: sb.client }));
vi.mock('bcryptjs', () => ({ default: bcryptMock }));

import { createApp } from '../src/app'; // siempre DESPUÉS de los vi.mock
```

Repetir este bloque en cada test file que use Supabase.

---

## Estructura

```
tests/
├── setup.ts                      Env determinista (JWT_SECRET, EMAILS_ENABLED=false, etc.)
├── helpers/
│   ├── supabaseMock.ts           createSupabaseMock() chainable + thenable
│   ├── factories.ts              makeUser, makeImpuesto, makeJWT
│   └── auth.ts                   bearerFor, expiredBearerFor, badSignatureBearerFor
├── middleware/
│   ├── auth.test.ts              middleware authenticate (unit)
│   └── roles.test.ts             middleware requireRole (unit)
├── auth.test.ts                  POST /api/auth/login
├── admin.test.ts                 /api/admin/contadores/*
├── clientes.test.ts              /api/clientes/*
└── impuestos.test.ts             /api/impuestos/* + /mis-impuestos/*
```

`vitest.config.ts` y `tests/setup.ts` cargan antes que cualquier import del SUT.

---

## Helpers

### `tests/setup.ts`
Setea env requeridas por módulos top-level (`lib/supabase`, `emailService`) **antes** que se carguen. `EMAILS_ENABLED=false` por default — tests que validan envío real lo pisan con `vi.stubEnv`.

### `tests/helpers/supabaseMock.ts`
`createSupabaseMock()` devuelve `{ client, queue, push, calls, reset }`.
- `client` — proxy con `.from()` que arma builders chainables (`select/insert/update/delete/eq/neq/lt/order/...`).
- Builder es **thenable**: `await supabase.from(...).update(...).eq(...)` resuelve sin `.single()`.
- Cada test programa una cola de respuestas con `queue([{ table, result }, ...])`. Cada `from()` consume una entrada en orden. Falla loud si la tabla no matchea (atrapa bugs de test temprano).
- `calls` registra `{ table, op, filters, payload, terminal }` para aserciones tipo `expect(sb.calls[0].filters).toContainEqual(['eq', 'estudio_id', 'estudio-A'])`.
- `op` se fija al **primero** del chain (`insert().select()` registra `op='insert'`, no `'select'`).

### `tests/helpers/factories.ts`
- `makeUser(overrides)` — admin queda con `estudio_id: null`; resto con `'estudio-1'`. IDs únicos por counter.
- `makeImpuesto(overrides)` — defaults `estado: 'pendiente'`, fecha `2030-01-15`. Si `estado: 'pagado'`, setea `pagado_at` + `pagado_por`.
- `makeJWT(user, { expiresIn?, secret? })` — firma con `process.env.JWT_SECRET`. Permite override para token expirado o firma inválida.

### `tests/helpers/auth.ts`
- `bearerFor(user)` → `'Bearer <jwt>'` para `.set('Authorization', ...)`.
- `expiredBearerFor(user)` — `expiresIn: -10` → token expirado al instante (sin mockear Date).
- `badSignatureBearerFor(user)` — firmado con `'wrong-secret'` → 401 por firma.
- `MALFORMED_HEADER` — string sin prefix `Bearer `.

---

## Tests aplicados

### `tests/middleware/auth.test.ts` — 7 tests
Driver directo del middleware con mocks de `req`/`res`/`next`. No usa Supertest.

| Caso | Verifica |
|------|----------|
| 401 sin Authorization header | error `'Token requerido'`, `next` no llamado |
| 401 si header malformado | mismo error |
| 401 con token expirado | error `'Token inválido o expirado'` |
| 401 con firma inválida | mismo error |
| 401 con JWT sintácticamente roto | 401 |
| next() + req.user con token válido | payload completo en req.user |
| Admin con estudio_id null preservado | role `admin`, estudio_id `null` |

### `tests/middleware/roles.test.ts` — 5 tests
| Caso | Verifica |
|------|----------|
| 401 sin req.user | `'No autenticado'` |
| 403 rol no autorizado | `'Sin permiso para esta acción'` |
| next() si rol coincide | next llamado, no status |
| Multi-rol acepta cualquiera de la lista | next |
| Multi-rol rechaza fuera de la lista | 403 |

### `tests/auth.test.ts` — 9 tests
Login endpoint vía Supertest. Mock de Supabase + bcrypt + loginLimiter pass-through.

| Caso | Verifica |
|------|----------|
| 400 falta email | error `'Email y password requeridos'`, 0 calls a DB |
| 400 falta password | mismo |
| 400 body vacío | 400 |
| 401 user no existe | `'Credenciales inválidas'`, bcrypt no llamado |
| 500 si DB error | `'Error interno del servidor'` |
| 403 si `activo: false` | `'Usuario inactivo'`, bcrypt no llamado (corta antes) |
| 401 password incorrecta | bcrypt llamado con `(plain, hash)`, error genérico |
| 200 + token válido | JWT decodea con secret de test, payload correcto, **TTL 8h exacto**, `password_hash` no leakeado |
| Chain Supabase verificado | `from('users').select().eq('email', X).maybeSingle()` |

### `tests/admin.test.ts` — 22 tests

**Auth gate** (3): 401 sin token, 403 si contador, 403 si cliente.

**POST /contadores** (6): 400 faltan campos, 400 password<8, 409 email duplicado (sin hashear), 400 estudio inexistente, 400 estudio inactivo, 201 happy con `bcrypt.hash(pw, 12)` + insert con `role: 'contador'`, sin password plaintext en payload.

**GET /contadores** (2): 200 lista filtrada por `eq('role','contador')`; 500 DB error.

**GET /contadores/:id** (2): 404 inexistente; 200 con doble eq (`id` + `role`).

**PATCH /contadores/:id** (4): 404, 400 sin campos, 409 email-conflict (verifica `neq('id', id)` excluye al propio user), 200 update con payload exacto, 200 solo nombre (skipea email-conflict check).

**PATCH /contadores/:id/estado** (4): 400 sin activo, 400 si activo no boolean, 404, 200 toggle inactivo.

### `tests/clientes.test.ts` — 20 tests

**Auth gate** (3): 401 sin token, 403 admin, 403 cliente. Endpoint requiere `requireRole('contador')`.

**POST /clientes** (5): 400 faltan, 400 password<8, 409 email, 201 happy con **`estudio_id` del JWT** (ignora intento de inyección `estudio_id: 'estudio-OTRO'` en body), 201 con `cuit`/`telefono` null si no enviados.

**GET /clientes — multi-tenant** (2): 200 lista filtrada por `estudio_id` del JWT; **contador B no recibe clientes de A** (filter `eq estudio_id=B`, nunca `=A`).

**GET /clientes/:id** (3): 404 inexistente, **404 cross-estudio** (contador B pidiendo cliente de A → query con `estudio_id=B` → null), 200 mismo estudio.

**PATCH /clientes/:id** (4): 400 sin campos, 404 cross-estudio, 409 email tomado, 200 update con `nombre+cuit+telefono` payload exacto.

**PATCH /clientes/:id/estado** (3): 400 si no boolean, 404 cross-estudio, 200 toggle.

### `tests/impuestos.test.ts` — 41 tests

**POST /impuestos — auth + validators** (12): 401 sin token, 403 admin, 403 cliente, 400 faltan campos, 400 tipo>100, 400 monto=0, 400 monto<0, 400 monto no número, 400 fecha mal formato, 400 fecha mes 13, 400 link_pago `http://`, 400 link_pago `javascript:`.

**POST /impuestos — flujo** (3): 404 cliente cross-estudio, 201 happy (insert con `estudio_id` + `creado_por` del JWT, email a cliente, notif insert con `tipo: 'nuevo', canal: 'email'`), 201 con `descripcion`/`link_pago` null.

**POST /impuestos — email** (1): 201 aunque `sendNuevoImpuesto` rechace (notif **no** se inserta porque el send falla antes; impuesto creado igual).

**GET /impuestos** (4): 200 lista filtrada por estudio, 200 con filter cliente_id, 200 con filter estado, 400 estado inválido (`cancelado`).

**GET /impuestos/:id** (2): 404 cross-estudio, 200 mismo estudio.

**PATCH /impuestos/:id** (7): 400 monto<0, 400 fecha mala, 400 link `http://`, 400 sin campos, 404 cross-estudio, **400 si pagado** (no editable), 200 update.

**PATCH /impuestos/:id/estado** (5): 404, 400 si ya pagado, 200 transición → pagado con `pagado_at` + `pagado_por: req.user.id`, **body `{estado:'vencido'}` es ignorado y setea pagado igual** (spec dice transición legal solo es la del cron), 200 vencido→pagado permitido.

**GET /mis-impuestos** (3): 401, 403 contador, 200 cliente solo ve los suyos agrupados en `pendientes/vencidos/pagados`. Aislamiento por `eq('cliente_id', JWT.id)` (cliente otro nunca matchea cliente_id de A).

**GET /mis-impuestos/:id** (3): 403 contador, 404 si no es del cliente, 200 si lo es.

---

## TODO — tests pendientes

### `tests/cron.test.ts` — alta prioridad
Mock `procesarVencidos` y `procesarRecordatorios` (ambas exportadas desde `vencimientosCron.ts`). Mock `supabase` chain + email service (`sendVencido`, `sendRecordatorio`). **No** usar `cron.schedule` real — invocar funciones directo.

| Caso | Verifica |
|------|----------|
| `procesarVencidos`: idempotencia | dos runs consecutivas → un solo `sendVencido` por impuesto, una sola notif insertada |
| `procesarVencidos`: anti-dup notif (orden corregido) | si ya hay notif vencido, NO se hace UPDATE estado ni se manda email |
| `procesarVencidos`: query principal | `from('impuestos').select(...).eq('estado','pendiente').lt('fecha_vencimiento', today)` |
| `procesarVencidos`: error de email no rompe loop | si `sendVencido` rechaza para impuesto X, sigue procesando Y/Z |
| `procesarVencidos`: notificación solo al cliente | sin join a contador; `to` es string del cliente, no array |
| `procesarRecordatorios`: ventana 3 días | filtra impuestos con `fecha_vencimiento` exactamente `today + 3` |
| `procesarRecordatorios`: anti-dup | no manda recordatorio si ya hay notif `recordatorio_3dias` |
| `procesarRecordatorios`: error email no rompe loop | igual que vencidos |

### `tests/emailService.test.ts` — alta prioridad
Mock `Resend` constructor → `emails.send` controlado. **No** mockear las funciones internas (`escapeHtml`, `safeHref`); testearlas a través del payload del send.

| Caso | Verifica |
|------|----------|
| `EMAILS_ENABLED=false` skipea | `Resend.emails.send` no llamado, no throw |
| `EMAILS_ENABLED=true` invoca send | con `from`, `to`, `subject`, `html` |
| `sendVencido(to: string)` | `to` es **string single** (no array), matchea spec actual |
| `escapeHtml`: `<script>` en nombre | HTML escapeado en payload (`&lt;script&gt;`) |
| `escapeHtml`: comillas + `&` en tipo | `&quot;`, `&amp;` |
| `safeHref`: rechaza `javascript:` | link_pago no aparece en HTML |
| `safeHref`: rechaza `http://` | mismo |
| `safeHref`: acepta `https://` | aparece como href válido |
| `sendNuevoImpuesto`: render mínimo | nombre, tipo, monto formateado, fecha en `dd/mm/yyyy` |
| Email falla → controller no rompe | ya cubierto en `impuestos.test.ts` (happy ya checkeado) |

Patrón: mockear `'resend'` con `vi.mock`. Como `emailService.ts` instancia `new Resend(API_KEY)` a nivel módulo, el mock debe estar hoisteado **antes** del primer import del módulo.

```ts
const { resendMock } = await vi.hoisted(async () => ({
  resendMock: { emails: { send: vi.fn().mockResolvedValue({ id: 'msg-1', error: null }) } },
}));
vi.mock('resend', () => ({ Resend: vi.fn(() => resendMock) }));
```

### `tests/internal.test.ts` — media prioridad
`POST /api/internal/run-cron` protegido por header `x-cron-secret`.

| Caso | Verifica |
|------|----------|
| 401 sin header | endpoint cerrado |
| 401 con secret incorrecto | constant-time compare ideal, igual 401 |
| 200 con secret correcto | dispara `procesarVencidos` + `procesarRecordatorios` (mockear ambas) |
| 500 si las jobs throw | no expone stack al cliente |

### `tests/health.test.ts` — baja prioridad
`GET /health` → 200 + `{ status: 'ok', timestamp }`. Smoke trivial.

### Tests adicionales que conviene
- **CORS gate** — origin permitido vs bloqueado; sin `ALLOWED_ORIGINS` → bloquea browsers con `Origin`.
- **Validators extraídos** — si se mueve fecha/HTTPS/monto a `validators.ts`, agregar `tests/validators.test.ts` con casos puros (sin app).
- **`crearImpuesto`: query duplicada al cliente** — bug menor mencionado en análisis (1 query para validar, otra para email). Si se optimiza, ajustar mock queue de impuestos.test.ts.

---

## Cosas a recordar al escribir nuevos tests

1. **Programar la cola de Supabase en orden exacto**. Si el controller hace 3 `from()`, programar 3. Si falta uno, error explícito de `supabaseMock`. Si sobra, no falla pero los siguientes tests heredan basura — siempre `sb.reset()` en `beforeEach`.
2. **No asumir `op='insert'` después de `.select()` encadenado**. El mock registra solo el primero del chain; el chain `insert().select().single()` queda como `op='insert'` con `payload` y `terminal='single'`.
3. **`maybeSingle()` vs `single()` vs `await` directo**. El mock soporta los tres pero la respuesta puede diferir si se programa `resultSingle`/`resultMaybeSingle` separado.
4. **`vi.hoisted` con async + dynamic import** es la única forma estable. Sync `require` no resuelve `.ts` en Vitest 4 + Vite.
5. **JWT real** — payloads decodean con `jwt.verify(token, process.env.JWT_SECRET!)`. Útil para validar TTL o claims sin acoplarse al endpoint.
6. **Multi-tenant**: cada nuevo endpoint que toque datos del estudio debe tener un test "cross-estudio → 404" verificando que el filter incluye `eq('estudio_id', JWT.estudio_id)`. **Sin esto, RLS del lado app está roto y no se nota.**
7. **`createApp()` por test** (`beforeEach`) — Express estado limpio. No reusar entre tests.
8. **Sourcemap warning de `node-cron`** es ruido upstream, ignorable.

---

## Coverage actual aproximado

Cubierto bien:
- middlewares (auth, roles)
- auth/login flow
- admin (CRUD contadores)
- clientes (CRUD + multi-tenant)
- impuestos (CRUD + validators + email path + mis-impuestos)

Sin cubrir aún:
- vencimientosCron (jobs)
- emailService (escape/safeHref/templates)
- routes/internal (run-cron)
- CORS / health (smoke)
