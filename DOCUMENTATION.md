# Sistema de Gestión Contable — Backend

Documentación técnica completa del backend.

---

## 1. Resumen del producto

Backend HTTP/REST para un sistema multi-tenant de gestión de impuestos de estudios contables. Tres tipos de usuario:

- **admin** (global, sin estudio): crea contadores y los asigna a estudios.
- **contador** (perteneciente a un estudio): gestiona los clientes del estudio y los impuestos asignados a esos clientes.
- **cliente** (perteneciente a un estudio): consulta sus propios impuestos.

El sistema notifica por email tres eventos: nuevo impuesto creado, recordatorio 3 días antes del vencimiento y vencimiento no pagado.

---

## 2. Stack y dependencias

| Componente | Uso |
|---|---|
| Node.js + TypeScript | Runtime y tipado estático |
| Express 5 | Framework HTTP |
| Supabase (`@supabase/supabase-js`) | Cliente Postgres (vía Service Key, sin RLS desde backend) |
| bcryptjs | Hash de contraseñas (cost 12) |
| jsonwebtoken | Emisión y validación de JWT |
| Resend | Envío de emails transaccionales |
| node-cron | Jobs programados |
| express-rate-limit | Rate limiting de login |
| cors | CORS con allowlist |
| dotenv | Carga de variables de entorno |

Gestor de paquetes: **pnpm** (`packageManager: pnpm@10.33.0`).

Scripts disponibles (`package.json`):
- `pnpm dev` — `nodemon` + `ts-node` (desarrollo)
- `pnpm build` — compila a `dist/`
- `pnpm start` — corre `dist/index.js` (producción)
- `pnpm test` — corre Vitest en modo `run`
- `pnpm test:watch` — Vitest en watch
- `pnpm test:cov` — Vitest + coverage v8

---

## 3. Estructura de carpetas

```
src/
├── app.ts                         # createApp(): construye Express + middlewares + routers
├── index.ts                       # Bootstrap: valida env, app.listen, initCronJobs
├── lib/
│   └── supabase.ts                # Singleton del cliente Supabase
├── types/
│   └── index.ts                   # Tipos compartidos (User, Impuesto, JwtPayload, ...)
├── utils/
│   └── validators.ts              # isValidEmail() — validación de formato de email
├── middleware/
│   ├── auth.ts                    # authenticate (JWT)
│   ├── roles.ts                   # requireRole(...roles)
│   └── rateLimits.ts              # loginLimiter
├── routes/
│   ├── auth.ts                    # /api/auth
│   ├── admin.ts                   # /api/admin/contadores
│   ├── clientes.ts                # /api/clientes
│   ├── impuestos.ts               # /api/impuestos
│   └── internal.ts                # /api/internal (cron trigger con shared secret)
├── controllers/
│   ├── authController.ts          # login()
│   ├── adminController.ts         # CRUD contadores
│   ├── clientesController.ts      # CRUD clientes + cambio de password
│   └── impuestosController.ts     # CRUD impuestos + endpoints de cliente
├── services/
│   └── emailService.ts            # sendNuevoImpuesto / sendRecordatorio / sendVencido
├── jobs/
│   └── vencimientosCron.ts        # Crons diarios: vencidos + recordatorios 3 días
└── database/
    └── schema.sql                 # DDL completo (tablas, índices, triggers, enums)

tests/
├── setup.ts                       # env vars de test
├── app.test.ts                    # trust proxy + bootstrap
├── auth.test.ts                   # POST /api/auth/login
├── admin.test.ts                  # /api/admin/*
├── clientes.test.ts               # /api/clientes/*
├── impuestos.test.ts              # /api/impuestos/*
├── helpers/                       # supabaseMock, factories, auth
├── middleware/                    # tests de auth + roles middleware
└── utils/
    └── validators.test.ts         # isValidEmail
```

---

## 4. Variables de entorno

Cargadas en `src/index.ts` con `dotenv/config`. Si falta alguna, el servidor **no arranca** (lanza error).

### Requeridas

| Variable | Para qué se usa |
|---|---|
| `JWT_SECRET` | Firma y verificación de tokens JWT |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Service Role Key (sí, bypasea RLS — cuidar) |
| `RESEND_API_KEY` | API key de Resend para email |

La validación de env se saltea cuando `NODE_ENV === 'test'`.

### Opcionales

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `ALLOWED_ORIGINS` | `[]` (CORS bloquea todo) | CSV de orígenes permitidos por CORS |
| `EMAIL_FROM` | `Sistema Contable <notificaciones@tudominio.com>` | Remitente de los emails |
| `EMAILS_ENABLED` | `false` salvo `'true'` | Si no es `'true'`, los `sendXxx` loguean y retornan sin pegarle a Resend (útil en dev/test) |
| `CRON_SECRET` | (sin default) | Shared secret para `POST /api/internal/run-cron`. Si no está seteado, ese endpoint responde `503` |

⚠️ Si `ALLOWED_ORIGINS` no se setea, **ningún navegador con `Origin` podrá pegarle al backend**. Requests sin header `Origin` (curl, server-to-server) sí pasan.

---

## 5. Bootstrap

Dividido en dos archivos:

- **`src/app.ts`** — exporta `createApp()`. Sin side effects (puede importarse en tests sin abrir puertos ni arrancar crons). Es lo que se mockea / monta en supertest.
- **`src/index.ts`** — carga `.env`, valida vars, llama `createApp()`, abre el puerto y arranca el cron.

### `createApp()` — orden exacto

1. `express()`.
2. `app.set('trust proxy', 1)` — necesario detrás de Render/Vercel/Cloudflare para que `req.ip` y `express-rate-limit` vean la IP real del cliente, no la del proxy.
3. CORS con allowlist desde `ALLOWED_ORIGINS`.
4. `express.json()`.
5. `GET /health` → `{ status: 'ok', timestamp }`.
6. Montaje de routers:
   - `/api/auth` → `authRouter`
   - `/api/admin` → `adminRouter`
   - `/api/clientes` → `clientesRouter`
   - `/api/impuestos` → `impuestosRouter`
   - `/api/internal` → `internalRouter` (cron trigger)

### `index.ts`

1. `import 'dotenv/config'`.
2. Si `NODE_ENV !== 'test'`, valida que existan todas las env vars requeridas — si falta una, throw.
3. `createApp()` + `app.listen(PORT)`.
4. `initCronJobs()` (2 jobs a las 08:00 ART).

---

## 6. Modelo de datos (`src/database/schema.sql`)

### 6.1 Enums

```sql
role               = 'admin' | 'contador' | 'cliente'
estado_impuesto    = 'pendiente' | 'vencido' | 'pagado'
tipo_notificacion  = 'nuevo' | 'recordatorio_3dias' | 'vencido'
```

### 6.2 Tablas

#### `estudios`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | UUID PK | `uuid_generate_v4()` |
| `nombre` | VARCHAR(255) NOT NULL | |
| `activo` | BOOLEAN NOT NULL | default `true` |
| `created_at` | TIMESTAMPTZ NOT NULL | default `NOW()` |

#### `users`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | UUID PK | |
| `estudio_id` | UUID FK → `estudios(id)` | NULL solo si `role='admin'` |
| `nombre` | VARCHAR(255) NOT NULL | |
| `email` | VARCHAR(255) NOT NULL UNIQUE | |
| `password_hash` | VARCHAR(255) NOT NULL | bcrypt |
| `role` | role NOT NULL | |
| `cuit` | VARCHAR(13) | nullable |
| `telefono` | VARCHAR(20) | nullable |
| `activo` | BOOLEAN NOT NULL | default `true` |
| `created_at` | TIMESTAMPTZ NOT NULL | |

CHECK `chk_estudio_por_role`: admin ↔ `estudio_id IS NULL`; contador/cliente ↔ `estudio_id IS NOT NULL`.

Índices: `estudio_id`, `role`, `email`.

#### `impuestos`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | UUID PK | |
| `estudio_id` | UUID FK NOT NULL | RESTRICT |
| `cliente_id` | UUID FK → `users` NOT NULL | RESTRICT |
| `creado_por` | UUID FK → `users` NOT NULL | el contador que lo creó |
| `tipo` | VARCHAR(100) NOT NULL | nombre del impuesto |
| `monto` | DECIMAL(12,2) NOT NULL | CHECK `monto > 0` |
| `fecha_vencimiento` | DATE NOT NULL | |
| `descripcion` | TEXT | nullable |
| `link_pago` | VARCHAR(500) | nullable; HTTPS validado en backend |
| `estado` | estado_impuesto NOT NULL | default `pendiente` |
| `pagado_at` | TIMESTAMPTZ | NULL si no está pagado |
| `pagado_por` | UUID FK → `users` | NULL si no está pagado |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL | trigger mantiene `updated_at` |

CHECK `chk_pagado_completo`: `estado='pagado'` ↔ `pagado_at IS NOT NULL` ∧ `pagado_por IS NOT NULL`.

Trigger `trg_impuestos_updated_at` (BEFORE UPDATE): setea `updated_at = NOW()`.

Índices: `cliente_id`, `estudio_id`, `estado`, `fecha_vencimiento`, y compuesto parcial `idx_impuestos_cron(estado, fecha_vencimiento) WHERE estado='pendiente'` para el cron.

#### `notificaciones`
| Columna | Tipo | Notas |
|---|---|---|
| `id` | UUID PK | |
| `impuesto_id` | UUID FK NOT NULL | ON DELETE CASCADE |
| `user_id` | UUID FK NOT NULL | ON DELETE CASCADE |
| `tipo` | tipo_notificacion NOT NULL | |
| `canal` | VARCHAR(20) NOT NULL | default `'email'` |
| `enviada_at` | TIMESTAMPTZ NOT NULL | |

Índices: `impuesto_id`, compuesto `(impuesto_id, tipo)` para el anti-duplicado del cron.

---

## 7. Autenticación y autorización

### 7.1 JWT

- Emitido en `POST /api/auth/login`.
- TTL configurable por request:
  - Sin `remember` o `remember: false` → `expiresIn: '8h'`.
  - `remember: true` → `expiresIn: '10d'` (sesión persistente).
- La respuesta del login incluye `expires_at` (ISO string) para que el frontend conozca el momento exacto de expiración.
- Payload (`JwtPayload`): `{ id, email, role, estudio_id }`.
- Validado por `authenticate` (`src/middleware/auth.ts`):
  - Lee header `Authorization: Bearer <token>`.
  - Si falta o no empieza con `Bearer ` → `401 { error: 'Token requerido' }`.
  - Si falla `jwt.verify` → `401 { error: 'Token inválido o expirado' }`.
  - En éxito: setea `req.user = payload` y llama `next()`.

`req.user` está tipado globalmente vía `declare global { namespace Express { interface Request { user?: JwtPayload } } }`.

> ⚠️ JWT stateless: el token sigue válido hasta su `exp` aunque el usuario sea desactivado o cambie su password. No hay revocación server-side.

### 7.2 Autorización por rol

`requireRole(...roles)` (`src/middleware/roles.ts`):
- Si no hay `req.user` → 401 (defensa en profundidad; ya debería existir).
- Si `req.user.role` no está en la lista → `403 { error: 'Sin permiso para esta acción' }`.

### 7.3 Aislamiento por estudio (multi-tenancy)

El backend filtra **siempre** por `estudio_id` tomado de `req.user!.estudio_id` en queries de contador y cliente. No depende de RLS de Supabase — usa la Service Key, que bypasea RLS. **Toda nueva query a `users` o `impuestos` debe filtrar por `estudio_id` cuando el rol no es `admin`**, o se rompe el aislamiento entre estudios.

Esto aplica también a los endpoints del cliente final (`/mis-impuestos`, `/mis-impuestos/:id`): además del `cliente_id` del JWT, las queries filtran por `estudio_id` como defensa en profundidad.

### 7.4 Rate limit y `trust proxy`

- `loginLimiter` (`src/middleware/rateLimits.ts`): 10 requests / 15 min por IP. Solo aplicado a `POST /api/auth/login`.
- `createApp()` setea `app.set('trust proxy', 1)`. Sin esto, detrás de Render/Vercel/Cloudflare `req.ip` toma la IP del proxy y **todos los clientes comparten el mismo bucket de rate-limit** (DoS trivial del login). Con `trust proxy=1`, Express toma el último valor del header `X-Forwarded-For`, que corresponde al cliente real.

### 7.5 Anti-enumeration en login

El endpoint de login devuelve **el mismo status y body** (`401 { error: 'Credenciales inválidas' }`) en los tres casos de credencial inválida: email inexistente, password incorrecta, usuario inactivo. Un atacante no puede distinguirlos desde la respuesta para enumerar emails registrados.

Errores de validación previa (campos faltantes, formato de email inválido) sí devuelven `400` — son input validation, no revelan información del backend.

### 7.6 Validación de formato de email

`isValidEmail()` en `src/utils/validators.ts` valida:
- Es string.
- Longitud ≤ 254 chars.
- Regex `^[^\s@]+@[^\s@]+\.[^\s@]+$` (un `@`, al menos un `.` en domain, sin whitespace).

Se aplica en todos los endpoints que aceptan email del usuario: `login`, `POST/PATCH /api/admin/contadores`, `POST/PATCH /api/clientes`. Si el formato es inválido → `400 { error: 'Email inválido' }` antes de tocar DB o hashear password.

---

## 8. Endpoints — referencia completa

Convenciones:
- `Auth:` indica si requiere JWT y qué rol.
- Los body params marcados con `*` son requeridos.
- Errores genéricos no documentados: `500 { error: 'Error interno del servidor' }`.

### 8.1 Salud

#### `GET /health`
- Auth: ninguna.
- Responde `200 { status: 'ok', timestamp }`.

---

### 8.2 `/api/auth`

#### `POST /api/auth/login`
- Auth: ninguna. Rate-limit: 10/15 min (por IP real gracias a `trust proxy`).
- Body: `email*`, `password*`, `remember?` (boolean, default `false`).
- Flujo:
  1. Valida campos requeridos → 400 si faltan.
  2. Valida formato de email con `isValidEmail` → 400 `'Email inválido'` si no.
  3. Busca user por email. Si no existe, si `activo=false` o si password no matchea → `401 { error: 'Credenciales inválidas' }` (los tres casos son indistinguibles desde el cliente).
  4. Firma JWT con `expiresIn: '8h'` o `'10d'` según `remember`.
- 200:
  ```json
  {
    "token": "<jwt>",
    "expires_at": "2026-05-12T03:00:00.000Z",
    "user": { "id", "nombre", "email", "role", "estudio_id" }
  }
  ```
- 400 falta email/password o formato de email inválido · 401 credenciales inválidas (incluye user inactivo).

---

### 8.3 `/api/admin/contadores` — solo `admin`

Todo el router aplica `authenticate` + `requireRole('admin')`.

#### `POST /api/admin/contadores`
- Body: `nombre*`, `email*`, `password*` (mín 8), `estudio_id*`.
- Validaciones en orden: campos requeridos → formato de email (`isValidEmail`) → password ≥ 8 → email no tomado → estudio existe y activo.
- Hashea password (bcrypt cost 12), inserta `role='contador'`, `activo=true`.
- 201 → datos del contador (sin `password_hash`).
- 400 faltan campos / email inválido / password corta / estudio inactivo · 409 email duplicado.

#### `GET /api/admin/contadores`
- Lista todos los contadores ordenados por `created_at DESC`.

#### `GET /api/admin/contadores/:id`
- Devuelve un contador. 404 si no existe o no es `role='contador'`.

#### `PATCH /api/admin/contadores/:id`
- Body opcional: `nombre`, `email`.
- Si se manda `email`: valida formato (`isValidEmail`) y unicidad.
- 400 si no se envió ningún campo o si el email tiene formato inválido · 404 no existe · 409 email duplicado.

#### `PATCH /api/admin/contadores/:id/estado`
- Body: `activo*` (boolean).
- Activa / desactiva (soft delete). Un contador inactivo no puede loguear — el login devuelve `401 'Credenciales inválidas'` (mismo error que credencial inválida, para no enumerar usuarios).

---

### 8.4 `/api/clientes` — solo `contador`

Todo el router aplica `authenticate` + `requireRole('contador')`. Las queries filtran por `req.user!.estudio_id`.

#### `POST /api/clientes`
- Body: `nombre*`, `email*`, `password*` (mín 8), `cuit?`, `telefono?`.
- `estudio_id` se toma del JWT del contador (nunca del body — si el body lo manda, se ignora).
- Validaciones: campos requeridos → formato de email (`isValidEmail`) → password ≥ 8 → unicidad de email global.
- 201 → cliente creado · 400 faltan campos / email inválido / password corta · 409 email duplicado.

#### `GET /api/clientes`
- Lista clientes del estudio del contador, ordenados por `nombre ASC`.

#### `GET /api/clientes/:id`
- Devuelve cliente del estudio. 404 si no es del estudio del contador o no existe.

#### `PATCH /api/clientes/:id`
- Body opcional: `nombre`, `email`, `cuit`, `telefono`.
- Si se manda `email`: valida formato (`isValidEmail`) y unicidad.
- 400 si email tiene formato inválido o si no se envió ningún campo · 404 no existe (incluye cliente de otro estudio) · 409 email duplicado.

#### `PATCH /api/clientes/:id/estado`
- Body: `activo*` (boolean). Soft delete.

#### `PATCH /api/clientes/:id/password`
- Reset de password por parte del contador del estudio.
- Body: `password*` (string, mín 8).
- Filtra `role='cliente'` + `estudio_id = req.user.estudio_id` (no permite cambiar password de admin/contador o de cliente de otro estudio).
- 204 en éxito · 400 password corta o ausente · 404 cliente no encontrado en el estudio.
- ⚠️ El cambio de password **no invalida** los JWT ya emitidos (no hay revocación stateful).

---

### 8.5 `/api/impuestos` — `contador` y `cliente`

⚠️ **Orden de las rutas importa**: las rutas de cliente (`/mis-impuestos`, `/mis-impuestos/:id`) están registradas **antes** que las de contador (`/:id`) para que Express no las matchee como `/:id`.

#### Endpoints de cliente — `requireRole('cliente')`

##### `GET /api/impuestos/mis-impuestos`
- Filtra por `cliente_id = req.user.id` **y** `estudio_id = req.user.estudio_id` (defensa en profundidad multi-tenant).
- Devuelve los impuestos del cliente autenticado, agrupados:
  ```json
  { "pendientes": [...], "vencidos": [...], "pagados": [...] }
  ```
- Orden interno por `fecha_vencimiento ASC`.

##### `GET /api/impuestos/mis-impuestos/:id`
- Filtra por `id` + `cliente_id = req.user.id` + `estudio_id = req.user.estudio_id`. 404 si no matchea cualquiera de los tres.

#### Endpoints de contador — `requireRole('contador')`

##### `POST /api/impuestos`
- Body: `cliente_id*`, `tipo*` (≤100 chars), `monto*` (número > 0), `fecha_vencimiento*` (`YYYY-MM-DD`), `descripcion?`, `link_pago?` (HTTPS).
- Validaciones:
  - `cliente_id` debe existir, ser `role='cliente'` y pertenecer al estudio del contador.
  - `monto` finito y positivo.
  - `fecha_vencimiento` regex `^\d{4}-\d{2}-\d{2}$` + `Date.parse` válido.
  - `link_pago` debe empezar con `https://` (regex case-insensitive).
- Inserta con `estado='pendiente'`, `creado_por = req.user.id`.
- **Side effect (no fatal)**: dispara `sendNuevoImpuesto` al email del cliente y registra en `notificaciones` con `tipo='nuevo'`. Si falla, loguea pero responde 201.
- 201 → impuesto creado · 400 validaciones · 404 cliente no encontrado.

##### `GET /api/impuestos`
- Query params opcionales: `cliente_id`, `estado` (`pendiente|vencido|pagado`).
- Filtra por `estudio_id` del contador, ordena por `fecha_vencimiento ASC`.
- 400 si `estado` es inválido.

##### `GET /api/impuestos/:id`
- Devuelve impuesto del estudio. 404 si no.

##### `PATCH /api/impuestos/:id`
- Body opcional: `tipo`, `monto`, `fecha_vencimiento`, `descripcion`, `link_pago` (mismas validaciones que en POST).
- **No se puede editar un impuesto `pagado`** → 400.
- 400 si no se enviaron campos.

##### `PATCH /api/impuestos/:id/estado`
- Marca el impuesto como `pagado`. No acepta body con un estado arbitrario; siempre setea `estado='pagado'`, `pagado_at=NOW()`, `pagado_por=req.user.id`.
- 400 si ya está pagado.

> **Nota**: la transición `pendiente → vencido` es exclusivamente automática (cron). Solo el cron escribe `estado='vencido'`.

---

### 8.6 `/api/internal` — trigger manual de cron

Endpoint protegido por shared secret (no por JWT). Pensado para que un scheduler externo (Vercel Cron, GitHub Actions, cron de un host externo) dispare los jobs cuando el server corre en un entorno donde `node-cron` no es confiable (ej. serverless).

#### `POST /api/internal/run-cron`
- Header `x-cron-secret: <CRON_SECRET>` (comparación con `crypto.timingSafeEqual`).
- Body opcional: `{ "job": "vencidos" | "recordatorios" | "all" }`. Default `"all"`.
- 200 → `{ status: 'ok', ran: ['vencidos', 'recordatorios'] }`.
- 400 si `job` no es uno de los valores válidos.
- 401 si no manda `x-cron-secret` · 403 si el secret no matchea.
- 503 si `CRON_SECRET` no está configurado en el server (forzar la rotación o configuración explícita en prod).

---

## 9. Flujos clave

### 9.1 Flujo de creación de impuesto

```
contador POST /api/impuestos
  └─ valida body
  └─ verifica cliente del mismo estudio
  └─ INSERT impuestos (estado='pendiente')
  └─ try:
       └─ SELECT cliente.email, nombre
       └─ Resend.send → "Nuevo vencimiento"
       └─ INSERT notificaciones (tipo='nuevo')
     catch: console.error, no rompe la respuesta
  └─ 201 con el impuesto
```

### 9.2 Cron jobs (`src/jobs/vencimientosCron.ts`)

Dos jobs registrados en `initCronJobs()`, ambos a las **08:00 ART** (`America/Argentina/Buenos_Aires`). Ambos también son disparables vía `POST /api/internal/run-cron` (ver 8.6).

#### Job 1 — `procesarVencidos`
1. `today = fecha actual en zona AR` (formateada `YYYY-MM-DD`).
2. SELECT impuestos `estado='pendiente'` con `fecha_vencimiento < today`, joins a `users` para email y nombre del cliente.
3. Para cada uno:
   - Si ya existe notificación `tipo='vencido'` para ese impuesto → skip (anti-dup vía tabla `notificaciones`).
   - UPDATE `estado='vencido'`.
   - `sendVencido(cliente.email, { nombre_cliente, tipo })` — un solo destinatario (el cliente).
   - INSERT 1 fila en `notificaciones` (`user_id = cliente.id`, `tipo='vencido'`).
4. Loguea `procesados/total`.

> ⚠️ El UPDATE de estado a `'vencido'` ocurre **antes** del envío de email. Si el email falla, el estado ya quedó cambiado pero no se inserta en `notificaciones`. El próximo cron run no lo reintenta porque ya no está en `pendiente`. Conocido — pendiente de fix.

#### Job 2 — `procesarRecordatorios`
1. `targetDate = today + 3 días` (suma en UTC con ancla `T12:00:00Z` para evitar saltos por DST).
2. SELECT impuestos `estado='pendiente'` con `fecha_vencimiento = targetDate`.
3. Para cada uno:
   - Si ya existe notif `tipo='recordatorio_3dias'` → skip.
   - `sendRecordatorio(cliente.email, ...)`.
   - INSERT notif `tipo='recordatorio_3dias'` para el cliente.
4. Loguea `enviados/total`.

#### Idempotencia
La tabla `notificaciones` actúa como log y como guardia: antes de enviar, se busca una fila `(impuesto_id, tipo)`; si existe, se omite el envío. Esto garantiza que correr el job dos veces no duplica emails para `recordatorios`. Para `vencidos` la guardia es indirecta (vía el cambio de estado, ver caveat arriba).

### 9.3 Flujo de email (`src/services/emailService.ts`)

Tres funciones:

| Función | Asunto | Destinatario(s) |
|---|---|---|
| `sendNuevoImpuesto` | `Nuevo vencimiento: <tipo>` | cliente |
| `sendRecordatorio` | `Recordatorio: <tipo> vence el DD/MM/YYYY` | cliente |
| `sendVencido` | `⚠️ Vencimiento no pagado: <tipo>` | cliente |

Todas:
- Honran `EMAILS_ENABLED`: si no es `'true'`, loguean `SKIP` y retornan sin pegarle a Resend (útil en dev/test).
- Usan `process.env.EMAIL_FROM` (con fallback) como remitente.
- Escapan HTML (`escapeHtml`) en cualquier valor proveniente del usuario (nombre, tipo).
- `link_pago` pasa por `safeHref`: solo se renderiza si empieza con `https://` — protege contra `javascript:` y similares.
- Formatean fecha como `DD/MM/YYYY` y monto en `es-AR / ARS` con `Intl.NumberFormat`.
- Logguean `[email] funcName OK | FAIL`. Re-lanzan el error para que el llamador decida (en `crearImpuesto` se atrapa y se ignora; en cron se atrapa por impuesto y continúa).

---

## 10. Decisiones / convenciones del código

- **Errores 500 genéricos**: todos los controladores devuelven `{ error: 'Error interno del servidor' }` en caso de fallo de Supabase o excepción no esperada. No se filtra mensaje interno al cliente.
- **Validación inline**: los controladores validan body manualmente (no hay zod / joi). Mantener la consistencia: regex + tipo + length checks. La única utility compartida es `isValidEmail()` en `src/utils/validators.ts`.
- **`maybeSingle()` vs `single()`**: se usa `maybeSingle()` cuando "no encontrado" es un caso esperado (404), y `single()` solo donde se garantiza la existencia (después de un INSERT con `select(...)`).
- **`USER_FIELDS`**: constante en `adminController` y `clientesController` que enumera explícitamente las columnas a retornar. **Nunca incluir `password_hash`** en este SELECT.
- **`estudio_id` desde JWT, no desde body**: previene que un contador cree recursos en otro estudio falsificando un campo. Vale para todo: clientes, impuestos. Aplica también a los endpoints del cliente final (`/mis-impuestos`, `/mis-impuestos/:id`).
- **Transición de estado de impuesto**:
  - `pendiente → pagado`: vía `PATCH /:id/estado` (contador).
  - `pendiente → vencido`: vía cron, no vía endpoint.
  - `pagado` es terminal (no se edita ni se vuelve a marcar).
- **HTTPS-only en `link_pago`**: validado en POST y PATCH del impuesto, y de nuevo en el HTML del email (`safeHref`).
- **CORS allowlist**: si `origin` viene undefined (curl, server-to-server) se permite. Si viene seteado, debe estar en la lista. Esto es deliberado.
- **Trust proxy**: siempre `1` en `createApp()`. Si en el futuro hay más capas de proxy (cliente → CDN → load balancer → app), subir este número o pasar una función de validación.
- **Login no enumera usuarios**: las tres condiciones de credencial inválida (email inexistente, password mala, user inactivo) responden idénticamente. No agregar mensajes específicos que rompan esta propiedad.

---

## 11. Riesgos conocidos / pendientes

1. **`SUPABASE_SERVICE_KEY` bypasea RLS**. Toda autorización vive en este backend; cualquier query nueva debe replicar el filtro `estudio_id` o el aislamiento se rompe.
2. **No hay paginación** en los listados (`/contadores`, `/clientes`, `/impuestos`). Si los volúmenes crecen, hay que agregar `range()` y un parámetro `?page` / `?limit`.
3. **JWT sin revocación**. El token sigue valido hasta `exp` aunque el user sea desactivado o cambie su password. Mitigación parcial: chequear `users.activo` en cada request (cost: 1 query/request) o introducir `token_version` en el JWT.
4. **No hay recuperación de password self-service**. Existe `PATCH /api/clientes/:id/password` (contador reset cliente). Para admin / contador no hay endpoint.
5. **Cron en proceso del server**. Si el server reinicia justo a las 08:00 ART se podría perder una corrida; en deploys serverless (Vercel) el cron de `node-cron` directamente no corre — usar el trigger externo vía `POST /api/internal/run-cron` con `CRON_SECRET`.
6. **Cron `vencidos` actualiza estado antes del email**. Si Resend falla, el impuesto queda en `vencido` pero sin notificación enviada y no se reintenta. Documentado en 9.2.
7. **Race condition pagado vs vencido**: el endpoint `PATCH /:id/estado` y el cron pueden pisarse si corren simultáneamente (SELECT-then-UPDATE no atómico). Mitigar con UPDATE condicional (`.neq('estado', 'pagado')`).
8. **`actualizarImpuesto` permite editar un impuesto `vencido`** (solo bloquea `pagado`). Si se cambia `fecha_vencimiento` a futuro, el estado queda `vencido` aunque la nueva fecha no haya vencido.
9. **Email globalmente único** (constraint del schema). Un contador del estudio A que intenta crear un cliente con un email ya usado en estudio B recibe 409 — leakea existencia cross-tenant. Tradeoff a discutir.
10. **No hay validación de fecha_vencimiento en el pasado**. Crear impuesto con fecha pasada genera email "nuevo" + email "vencido" al día siguiente.
11. **No se borra nada físicamente** — todo es soft delete vía `activo=false`. Asumir esto antes de agregar `DELETE` endpoints.
12. **Variables `.env` requeridas**: si falta una, el server tira en arranque. Mantener `.env.example` actualizado (no existe hoy — convendría crearlo).
13. **Sin Helmet ni headers de seguridad** (HSTS, X-Frame-Options, CSP). Render/Vercel meten algunos por default pero no todos.

---

## 12. Ejecutar localmente

```bash
pnpm install
cp .env .env.local   # editar con valores propios si hace falta
pnpm dev             # nodemon + ts-node, recarga al guardar
```

Servidor en `http://localhost:3000`. Healthcheck:

```bash
curl http://localhost:3000/health
```

Login de ejemplo:

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@x.com","password":"secret123"}'
```

---

## 13. Build y deploy

```bash
pnpm build    # compila TS → dist/
pnpm start    # node dist/index.js
```

Asegurar que el entorno de producción tiene **todas** las env vars requeridas (sección 4) o el proceso termina con error en el arranque.

Para correr el cron en producción es necesario que el proceso siga vivo (PM2, systemd, container con restart policy). Si se escala horizontalmente en múltiples instancias, **el cron correrá en cada una** — usar un único worker dedicado o agregar un lock distribuido.

---

## 14. Mapa rápido de archivos críticos

| Cambio que querés hacer | Archivo |
|---|---|
| Agregar un endpoint nuevo | `src/routes/<feature>.ts` + controller en `src/controllers/` + montaje en `src/app.ts` |
| Agregar un rol o permiso | `src/types/index.ts` (Role) + middleware `requireRole` ya soporta varargs |
| Cambiar template de email | `src/services/emailService.ts` |
| Cambiar horario / lógica del cron | `src/jobs/vencimientosCron.ts` |
| Agregar columna a una tabla | `src/database/schema.sql` + tipos en `src/types/index.ts` + queries afectadas |
| Cambiar duración del JWT | `src/controllers/authController.ts` (`expiresIn`, ramas `remember`) |
| Cambiar rate limit del login | `src/middleware/rateLimits.ts` |
| Cambiar el comportamiento detrás de proxy | `src/app.ts` (`app.set('trust proxy', ...)`) |
| Agregar origen al CORS | env var `ALLOWED_ORIGINS` (CSV) |
| Agregar un validador compartido | `src/utils/validators.ts` (hoy solo `isValidEmail`) |
| Disparar cron manualmente desde fuera del proceso | `POST /api/internal/run-cron` con `x-cron-secret` |

---

## 15. Tests

Suite con **Vitest** + **supertest**. Comandos:

```bash
pnpm test           # corre una sola vez
pnpm test:watch     # modo watch
pnpm test:cov       # con coverage v8
```

### 15.1 Setup

- `tests/setup.ts` setea env vars deterministas (`JWT_SECRET=test-secret`, `EMAILS_ENABLED=false`, etc.) antes de cualquier import del SUT.
- Vitest config (`vitest.config.ts`):
  - `pool: 'forks'`, `isolate: true` → cada archivo de test corre en su propio worker, mocks no contaminan otros archivos.
  - `clearMocks` y `restoreMocks` activos.
  - Coverage excluye `src/index.ts`, `src/types/**`, `src/database/**`.

### 15.2 Helpers (`tests/helpers/`)

- **`supabaseMock.ts`** — `createSupabaseMock()` devuelve un cliente compatible con el chain de `@supabase/supabase-js`. Soporta `from`, `select/insert/update/delete`, filtros (`eq/neq/lt/gt/...`), terminales (`single/maybeSingle/await`). Programás respuestas con `sb.queue([{ table, result }, ...])` e inspeccionás llamadas con `sb.calls`.
- **`factories.ts`** — `makeUser`, `makeImpuesto`, `makeJWT` (firma con el secret de test).
- **`auth.ts`** — `bearerFor(user)`, `expiredBearerFor(user)`, `badSignatureBearerFor(user)`.

### 15.3 Cobertura

Archivos de test alineados 1:1 con módulos:

| Test file | Cubre |
|---|---|
| `tests/app.test.ts` | `createApp()`, `trust proxy`, `req.ip` con `X-Forwarded-For` |
| `tests/auth.test.ts` | `POST /api/auth/login` (validaciones, anti-enumeration, remember, JWT TTL) |
| `tests/admin.test.ts` | `/api/admin/*` (auth gate, CRUD contadores, validación de email) |
| `tests/clientes.test.ts` | `/api/clientes/*` (auth gate, CRUD, password reset, multi-tenancy) |
| `tests/impuestos.test.ts` | `/api/impuestos/*` (contador + cliente, multi-tenancy con estudio_id, transiciones de estado) |
| `tests/middleware/auth.test.ts` | JWT middleware |
| `tests/middleware/roles.test.ts` | `requireRole(...roles)` |
| `tests/utils/validators.test.ts` | `isValidEmail` |

> Convención: cada test queda mockeado de DB y de email — no se pegan a servicios reales. Para validar el envío real de email, setear `EMAILS_ENABLED=true` y correr a mano contra Resend en un dominio de staging.

---

## 16. Changelog de la última auditoría (2026-05)

Cuatro fixes aplicados desde la auditoría de seguridad pre-producción:

| Fix | Archivo principal | Qué cambió |
|---|---|---|
| **FIX 1 — trust proxy** | `src/app.ts` | `app.set('trust proxy', 1)` para que `req.ip` y `express-rate-limit` vean la IP real detrás de Render/Vercel/Cloudflare, no la del proxy. |
| **FIX 2 — anti-enumeration en login** | `src/controllers/authController.ts` | Usuario inactivo ahora responde `401 { error: 'Credenciales inválidas' }` (antes era `403 'Usuario inactivo'`), idéntico a email inexistente y password mala. |
| **FIX 3 — `estudio_id` en endpoints de cliente** | `src/controllers/impuestosController.ts` | `misImpuestos` y `miImpuesto` ahora también filtran por `estudio_id` del JWT (defensa en profundidad). |
| **FIX 4 — validación de formato de email** | `src/utils/validators.ts` (nuevo) | `isValidEmail()` aplicado en `login`, `crearContador`, `actualizarContador`, `crearCliente`, `actualizarCliente`. Devuelve `400 { error: 'Email inválido' }` antes de tocar DB. |

Tests asociados: ver tabla en sección 15.3. Total: 153 tests en 8 archivos pasando verde después de los fixes.

Pendientes priorizados (no aplicados todavía — ver sección 11):

- Cron `vencidos` con estado antes del email (riesgo 6).
- Race condition `pagado` vs `vencido` (riesgo 7).
- `actualizarImpuesto` permite editar `vencido` sin resetear estado (riesgo 8).
- JWT sin revocación al desactivar / cambiar password (riesgo 3).
