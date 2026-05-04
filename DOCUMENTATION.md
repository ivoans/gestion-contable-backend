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

---

## 3. Estructura de carpetas

```
src/
├── index.ts                       # Bootstrap del server (Express + cron)
├── lib/
│   └── supabase.ts                # Singleton del cliente Supabase
├── types/
│   └── index.ts                   # Tipos compartidos (User, Impuesto, JwtPayload, ...)
├── middleware/
│   ├── auth.ts                    # authenticate (JWT)
│   ├── roles.ts                   # requireRole(...roles)
│   └── rateLimits.ts              # loginLimiter
├── routes/
│   ├── auth.ts                    # /api/auth
│   ├── admin.ts                   # /api/admin/contadores
│   ├── clientes.ts                # /api/clientes
│   └── impuestos.ts               # /api/impuestos
├── controllers/
│   ├── authController.ts          # login()
│   ├── adminController.ts         # CRUD contadores
│   ├── clientesController.ts      # CRUD clientes
│   └── impuestosController.ts     # CRUD impuestos + endpoints de cliente
├── services/
│   └── emailService.ts            # sendNuevoImpuesto / sendRecordatorio / sendVencido
├── jobs/
│   └── vencimientosCron.ts        # Crons diarios: vencidos + recordatorios 3 días
└── database/
    └── schema.sql                 # DDL completo (tablas, índices, triggers, enums)
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

### Opcionales

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `ALLOWED_ORIGINS` | `[]` (CORS bloquea todo) | CSV de orígenes permitidos por CORS |
| `EMAIL_FROM` | `Sistema Contable <notificaciones@tudominio.com>` | Remitente de los emails |

⚠️ Si `ALLOWED_ORIGINS` no se setea, **ningún navegador con `Origin` podrá pegarle al backend**. Requests sin header `Origin` (curl, server-to-server) sí pasan.

---

## 5. Bootstrap (`src/index.ts`)

Orden exacto del arranque:

1. `import 'dotenv/config'` — carga `.env`.
2. Validación de env requeridas — si falta una, throw.
3. Imports de routers + cron job.
4. Construcción del `app` Express.
5. CORS con allowlist desde `ALLOWED_ORIGINS`.
6. `express.json()` para parsear bodies.
7. `GET /health` → `{ status: 'ok', timestamp }`.
8. Montaje de routers:
   - `/api/auth` → `authRouter`
   - `/api/admin` → `adminRouter`
   - `/api/clientes` → `clientesRouter`
   - `/api/impuestos` → `impuestosRouter`
9. `app.listen(PORT)` y luego `initCronJobs()` (2 jobs a las 08:00 ART).

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

- Emitido en `POST /api/auth/login` con `expiresIn: '8h'`.
- Payload (`JwtPayload`): `{ id, email, role, estudio_id }`.
- Validado por `authenticate` (`src/middleware/auth.ts`):
  - Lee header `Authorization: Bearer <token>`.
  - Si falta o no empieza con `Bearer ` → `401 { error: 'Token requerido' }`.
  - Si falla `jwt.verify` → `401 { error: 'Token inválido o expirado' }`.
  - En éxito: setea `req.user = payload` y llama `next()`.

`req.user` está tipado globalmente vía `declare global { namespace Express { interface Request { user?: JwtPayload } } }`.

### 7.2 Autorización por rol

`requireRole(...roles)` (`src/middleware/roles.ts`):
- Si no hay `req.user` → 401 (defensa en profundidad; ya debería existir).
- Si `req.user.role` no está en la lista → `403 { error: 'Sin permiso para esta acción' }`.

### 7.3 Aislamiento por estudio (multi-tenancy)

El backend filtra **siempre** por `estudio_id` tomado de `req.user!.estudio_id` en queries de contador y cliente. No depende de RLS de Supabase — usa la Service Key, que bypasea RLS. **Toda nueva query a `users` o `impuestos` debe filtrar por `estudio_id` cuando el rol no es `admin`**, o se rompe el aislamiento entre estudios.

### 7.4 Rate limit

`loginLimiter` (`src/middleware/rateLimits.ts`): 10 requests / 15 min por IP. Solo aplicado a `POST /api/auth/login`.

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
- Auth: ninguna. Rate-limit: 10/15 min.
- Body: `email*`, `password*`.
- Flujo: busca usuario por email → si `activo=false` → 403 → compara bcrypt → firma JWT 8h.
- 200:
  ```json
  {
    "token": "<jwt>",
    "user": { "id", "nombre", "email", "role", "estudio_id" }
  }
  ```
- 400 falta email/password · 401 credenciales inválidas · 403 usuario inactivo.

---

### 8.3 `/api/admin/contadores` — solo `admin`

Todo el router aplica `authenticate` + `requireRole('admin')`.

#### `POST /api/admin/contadores`
- Body: `nombre*`, `email*`, `password*` (mín 8), `estudio_id*`.
- Valida que el email no esté tomado y que el estudio exista y esté activo.
- Hashea password (bcrypt cost 12), inserta `role='contador'`, `activo=true`.
- 201 → datos del contador (sin `password_hash`).
- 400 faltan campos / password corta / estudio inactivo · 409 email duplicado.

#### `GET /api/admin/contadores`
- Lista todos los contadores ordenados por `created_at DESC`.

#### `GET /api/admin/contadores/:id`
- Devuelve un contador. 404 si no existe o no es `role='contador'`.

#### `PATCH /api/admin/contadores/:id`
- Body opcional: `nombre`, `email`.
- Valida unicidad de email (si se pasa).
- 400 si no se envió ningún campo · 404 no existe · 409 email duplicado.

#### `PATCH /api/admin/contadores/:id/estado`
- Body: `activo*` (boolean).
- Activa / desactiva (soft delete). Un contador inactivo no puede loguear (login devuelve 403).

---

### 8.4 `/api/clientes` — solo `contador`

Todo el router aplica `authenticate` + `requireRole('contador')`. Las queries filtran por `req.user!.estudio_id`.

#### `POST /api/clientes`
- Body: `nombre*`, `email*`, `password*` (mín 8), `cuit?`, `telefono?`.
- `estudio_id` se toma del JWT del contador.
- 201 → cliente creado · 400 faltan campos / password corta · 409 email duplicado.

#### `GET /api/clientes`
- Lista clientes del estudio del contador, ordenados por `nombre ASC`.

#### `GET /api/clientes/:id`
- Devuelve cliente del estudio. 404 si no es del estudio del contador o no existe.

#### `PATCH /api/clientes/:id`
- Body opcional: `nombre`, `email`, `cuit`, `telefono`.
- Valida unicidad de email.

#### `PATCH /api/clientes/:id/estado`
- Body: `activo*` (boolean). Soft delete.

---

### 8.5 `/api/impuestos` — `contador` y `cliente`

⚠️ **Orden de las rutas importa**: las rutas de cliente (`/mis-impuestos`, `/mis-impuestos/:id`) están registradas **antes** que las de contador (`/:id`) para que Express no las matchee como `/:id`.

#### Endpoints de cliente — `requireRole('cliente')`

##### `GET /api/impuestos/mis-impuestos`
- Devuelve los impuestos del cliente autenticado, agrupados:
  ```json
  { "pendientes": [...], "vencidos": [...], "pagados": [...] }
  ```
- Orden interno por `fecha_vencimiento ASC`.

##### `GET /api/impuestos/mis-impuestos/:id`
- Devuelve un impuesto que pertenezca a `req.user.id`. 404 si no.

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

Dos jobs registrados en `initCronJobs()`, ambos a las **08:00 ART** (`America/Argentina/Buenos_Aires`).

#### Job 1 — `procesarVencidos`
1. `today = fecha actual en zona AR` (formateada `YYYY-MM-DD`).
2. SELECT impuestos `estado='pendiente'` con `fecha_vencimiento < today`, joins a `users` para email del cliente y del contador.
3. Para cada uno:
   - UPDATE `estado='vencido'`.
   - Si ya existe notificación `tipo='vencido'` para ese impuesto → skip (anti-dup).
   - `sendVencido([cliente.email, contador.email], { nombre_cliente, tipo })`.
   - INSERT 2 filas en `notificaciones` (cliente + contador, tipo `vencido`).
4. Loguea `procesados/total`.

`runVencimientosCron()` está exportado (corre solo `procesarVencidos`) — útil para disparar manualmente. **No está expuesto como endpoint** en este momento.

#### Job 2 — `procesarRecordatorios`
1. `targetDate = today + 3 días` (suma en UTC con ancla `T12:00:00Z` para evitar saltos por DST).
2. SELECT impuestos `estado='pendiente'` con `fecha_vencimiento = targetDate`.
3. Para cada uno:
   - Si ya existe notif `tipo='recordatorio_3dias'` → skip.
   - `sendRecordatorio(cliente.email, ...)`.
   - INSERT notif `tipo='recordatorio_3dias'` para el cliente.
4. Loguea `enviados/total`.

#### Idempotencia
La tabla `notificaciones` actúa como log y como guardia: antes de enviar, se busca una fila `(impuesto_id, tipo)`; si existe, se omite el envío. Esto garantiza que reiniciar el server o correr el job dos veces no duplica emails.

### 9.3 Flujo de email (`src/services/emailService.ts`)

Tres funciones:

| Función | Asunto | Destinatario(s) |
|---|---|---|
| `sendNuevoImpuesto` | `Nuevo vencimiento: <tipo>` | cliente |
| `sendRecordatorio` | `Recordatorio: <tipo> vence el DD/MM/YYYY` | cliente |
| `sendVencido` | `⚠️ Vencimiento no pagado: <tipo>` | cliente + contador |

Todas:
- Usan `process.env.EMAIL_FROM` (con fallback) como remitente.
- Escapan HTML (`escapeHtml`) en cualquier valor proveniente del usuario (nombre, tipo).
- `link_pago` pasa por `safeHref`: solo se renderiza si empieza con `https://` — protege contra `javascript:` y similares.
- Formatean fecha como `DD/MM/YYYY` y monto en `es-AR / ARS` con `Intl.NumberFormat`.
- Logguean `[email] funcName OK | FAIL`. Re-lanzan el error para que el llamador decida (en `crearImpuesto` se atrapa y se ignora; en cron se atrapa por impuesto y continúa).

---

## 10. Decisiones / convenciones del código

- **Errores 500 genéricos**: todos los controladores devuelven `{ error: 'Error interno del servidor' }` en caso de fallo de Supabase o excepción no esperada. No se filtra mensaje interno al cliente.
- **Validación inline**: los controladores validan body manualmente (no hay zod / joi). Mantener la consistencia: regex + tipo + length checks.
- **`maybeSingle()` vs `single()`**: se usa `maybeSingle()` cuando "no encontrado" es un caso esperado (404), y `single()` solo donde se garantiza la existencia (después de un INSERT con `select(...)`).
- **`USER_FIELDS`**: constante en `adminController` y `clientesController` que enumera explícitamente las columnas a retornar. **Nunca incluir `password_hash`** en este SELECT.
- **`estudio_id` desde JWT, no desde body**: previene que un contador cree recursos en otro estudio falsificando un campo. Vale para todo: clientes, impuestos.
- **Transición de estado de impuesto**:
  - `pendiente → pagado`: vía `PATCH /:id/estado` (contador).
  - `pendiente → vencido`: vía cron, no vía endpoint.
  - `pagado` es terminal (no se edita ni se vuelve a marcar).
- **HTTPS-only en `link_pago`**: validado en POST y PATCH del impuesto, y de nuevo en el HTML del email (`safeHref`).
- **CORS allowlist**: si `origin` viene undefined (curl, server-to-server) se permite. Si viene seteado, debe estar en la lista. Esto es deliberado.

---

## 11. Riesgos / cosas a tener en cuenta al mantener

1. **`SUPABASE_SERVICE_KEY` bypasea RLS**. Toda autorización vive en este backend; cualquier query nueva debe replicar el filtro `estudio_id` o el aislamiento se rompe.
2. **No hay paginación** en los listados (`/contadores`, `/clientes`, `/impuestos`). Si los volúmenes crecen, hay que agregar `range()` y un parámetro `?page` / `?limit`.
3. **No hay refresh tokens**. El JWT dura 8h y luego hay que volver a loguear. Si se quiere sesión más larga, hay que diseñar un mecanismo de refresh.
4. **No hay endpoint de cambio de contraseña** ni recuperación. Hay que crearlos (y mandarles email vía Resend) cuando se necesite.
5. **El cron corre dentro del mismo proceso del server**. Si el server reinicia justo a las 08:00 ART se podría perder una corrida. Si se necesita garantía, mover a un worker separado o a un job externo (Supabase scheduled functions, GitHub Actions, etc.).
6. **No hay tests automatizados** todavía. El script `test` es un placeholder.
7. **`sendVencido` envía un solo email con cliente y contador en `to`**, así que ambos ven los emails del otro. Si eso no se quiere, partirlo en dos envíos separados.
8. **No se borra nada físicamente** — todo es soft delete vía `activo=false`. Asumir esto antes de agregar `DELETE` endpoints.
9. **El compilador TS no compila tests porque no hay**, pero `tsc` (`pnpm build`) debería pasar limpio en CI antes de merge.
10. **Variables `.env` requeridas**: si falta una, el server tira en arranque. Mantener `.env.example` actualizado (no existe hoy — convendría crearlo).

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
| Agregar un endpoint nuevo | `src/routes/<feature>.ts` + controller en `src/controllers/` + montaje en `src/index.ts` |
| Agregar un rol o permiso | `src/types/index.ts` (Role) + middleware `requireRole` ya soporta varargs |
| Cambiar template de email | `src/services/emailService.ts` |
| Cambiar horario / lógica del cron | `src/jobs/vencimientosCron.ts` |
| Agregar columna a una tabla | `src/database/schema.sql` + tipos en `src/types/index.ts` + queries afectadas |
| Cambiar duración del JWT | `src/controllers/authController.ts` (`expiresIn`) |
| Cambiar rate limit del login | `src/middleware/rateLimits.ts` |
| Agregar origen al CORS | env var `ALLOWED_ORIGINS` (CSV) |
