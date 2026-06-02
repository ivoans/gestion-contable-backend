# API Reference — gestion-contable-backend

> Documento técnico del contrato de la API, generado a partir del código fuente real.
> Objetivo: servir de fuente de verdad para comparar contra la documentación del frontend
> y detectar incongruencias en el contrato.
>
> Convención: todo lo marcado como **(verificar)** no está determinado de forma inequívoca
> por el código y debe confirmarse manualmente.

---

## 1. Resumen

### Stack

| Componente | Tecnología |
|---|---|
| Lenguaje | TypeScript |
| Runtime / framework | Node.js + Express **5** |
| Base de datos | PostgreSQL vía Supabase (`@supabase/supabase-js`) |
| Acceso a datos | Cliente de Supabase con **Service Role Key** → **bypassa RLS**. El aislamiento multi-tenant lo hace el backend en código, no la base. |
| Auth | JWT (`jsonwebtoken`) |
| Hash de contraseñas | `bcryptjs`, cost factor **12** |
| Emails | Resend (`resend`) |
| Cron | `node-cron` (in-process) |
| Rate limiting | `express-rate-limit` |
| CORS | `cors` |

### Deploy

- **No hay URL de producción ni configuración de deploy commiteada en el repo.** El `.env.example` y `DOCUMENTATION.md` solo contienen placeholders (`https://app.tudominio.com`). Una configuración de Vercel existió pero fue removida (commit `8f43f80 chore(vercel): remove unused vercel configuration file`).
- **URL base de producción: (verificar)** — no figura en el código.
- Comentarios del código mencionan Render / Vercel / Cloudflare como proxies esperados (de ahí `trust proxy = 1`), pero no hay target de deploy fijado en el repo. **(verificar)**
- Arranque local: `pnpm dev` (puerto `3000` por default, configurable con `PORT`). Producción: `pnpm build` + `pnpm start` (`dist/index.js`).

### Autenticación

- **Tipo:** JWT firmado con `HS256` (default de `jsonwebtoken`), secreto en env `JWT_SECRET`.
- **Header:** `Authorization: Bearer <token>`.
- **Expiración:** `8h` por default; `10d` si el login se hace con `remember: true`.
- **Payload del token** (`JwtPayload`):
  ```json
  { "id": "uuid", "email": "string", "role": "admin|contador|cliente", "estudio_id": "uuid|null" }
  ```
- **No hay refresh token, logout ni revocación.** Un token sigue siendo válido hasta su expiración aunque el usuario se desactive o cambie su contraseña.
- El endpoint del cron (`/api/internal/run-cron`) **no usa JWT**; usa un shared secret en el header `x-cron-secret`.

### Roles y permisos (alto nivel)

Tres roles (enum `role`):

| Rol | `estudio_id` | Qué puede hacer |
|---|---|---|
| **admin** | siempre `NULL` | ABM de **contadores** (crear, listar, ver, editar, activar/desactivar). Es global, no pertenece a ningún estudio. **No** accede a clientes ni impuestos. |
| **contador** | obligatorio | ABM de **clientes** de su estudio + ABM de **impuestos** de su estudio (crear, listar, ver, editar, marcar pagado, cambiar contraseña de cliente). Todo acotado a su `estudio_id`. |
| **cliente** | obligatorio | Solo lectura de **sus propios** impuestos (`/mis-impuestos`, `/mis-impuestos/:id`). |

- Cada rol está limitado a sus rutas vía `requireRole(...)`. Un rol que pega a una ruta de otro recibe **403** `Sin permiso para esta acción`.
- No existe endpoint para crear admins ni estudios: ambos deben sembrarse directamente en la base. Ver sección 6.

---

## 2. Modelo de datos

Fuente: `src/database/schema.sql`. Extensión `uuid-ossp`; todos los IDs son UUID v4 con default `uuid_generate_v4()`.

### Enums

| Enum | Valores |
|---|---|
| `role` | `admin`, `contador`, `cliente` |
| `estado_impuesto` | `pendiente`, `vencido`, `pagado` |
| `tipo_notificacion` | `nuevo`, `recordatorio_3dias`, `vencido` |

### Tabla `estudios`

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK, default `uuid_generate_v4()` |
| `nombre` | VARCHAR(255) | NOT NULL |
| `activo` | BOOLEAN | NOT NULL, default `true` |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` |

### Tabla `users`

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `estudio_id` | UUID | FK → `estudios(id)` ON DELETE RESTRICT. NULL solo para admin. |
| `nombre` | VARCHAR(255) | NOT NULL |
| `email` | VARCHAR(255) | NOT NULL, **UNIQUE** |
| `password_hash` | VARCHAR(255) | NOT NULL. **Nunca se devuelve en respuestas.** |
| `role` | `role` | NOT NULL |
| `cuit` | VARCHAR(13) | nullable. Sin validación de formato en el backend. |
| `telefono` | VARCHAR(20) | nullable. Sin validación de formato en el backend. |
| `activo` | BOOLEAN | NOT NULL, default `true` |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` |

- **Constraint `chk_estudio_por_role`:** `role = 'admin'` ⇒ `estudio_id IS NULL`; cualquier otro rol ⇒ `estudio_id IS NOT NULL`.

**Shape de `User` que devuelven los endpoints** (campos `USER_FIELDS`, sin `password_hash`):
```json
{
  "id": "uuid",
  "estudio_id": "uuid|null",
  "nombre": "string",
  "email": "string",
  "role": "admin|contador|cliente",
  "cuit": "string|null",
  "telefono": "string|null",
  "activo": true,
  "created_at": "ISO-8601"
}
```
> Excepción: el objeto `user` del **login** trae un subconjunto distinto (`id, nombre, email, role, estudio_id`) — ver endpoint de login.

### Tabla `impuestos`

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `estudio_id` | UUID | NOT NULL, FK → `estudios(id)` RESTRICT |
| `cliente_id` | UUID | NOT NULL, FK → `users(id)` RESTRICT |
| `creado_por` | UUID | NOT NULL, FK → `users(id)` RESTRICT (el contador que lo creó) |
| `tipo` | VARCHAR(100) | NOT NULL |
| `monto` | DECIMAL(12,2) | NOT NULL, CHECK `monto > 0` |
| `fecha_vencimiento` | DATE | NOT NULL. Formato `YYYY-MM-DD`. |
| `descripcion` | TEXT | nullable |
| `link_pago` | VARCHAR(500) | nullable |
| `estado` | `estado_impuesto` | NOT NULL, default `pendiente` |
| `pagado_at` | TIMESTAMPTZ | nullable |
| `pagado_por` | UUID | nullable, FK → `users(id)` RESTRICT |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()`. Trigger `trg_impuestos_updated_at` lo actualiza en cada UPDATE. |

- **Constraint `chk_pagado_completo`:** `estado = 'pagado'` ⇒ `pagado_at` y `pagado_por` NOT NULL; `estado != 'pagado'` ⇒ ambos NULL.
- **Shape de respuesta:** `select('*')` → devuelve **todas** las columnas de arriba.
- **(verificar)** `monto` se tipa como `number` en TypeScript. PostgREST/Supabase puede serializar `DECIMAL` como número o como string según configuración; confirmar contra lo que parsea el frontend.

### Tabla `notificaciones`

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `impuesto_id` | UUID | NOT NULL, FK → `impuestos(id)` **ON DELETE CASCADE** |
| `user_id` | UUID | NOT NULL, FK → `users(id)` **ON DELETE CASCADE** |
| `tipo` | `tipo_notificacion` | NOT NULL |
| `canal` | VARCHAR(20) | NOT NULL, default `'email'` |
| `enviada_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` |

- Tabla interna. **No hay endpoints que la expongan.** Se usa solo para deduplicar notificaciones (índice `idx_notificaciones_dedup` sobre `(impuesto_id, tipo)`).

### Relaciones

```
estudios 1──N users        (users.estudio_id → estudios.id)
estudios 1──N impuestos     (impuestos.estudio_id → estudios.id)
users    1──N impuestos     (impuestos.cliente_id → users.id)   [el cliente]
users    1──N impuestos     (impuestos.creado_por → users.id)   [el contador]
users    1──N impuestos     (impuestos.pagado_por → users.id)   [quien marcó pagado]
impuestos 1──N notificaciones (notificaciones.impuesto_id → impuestos.id)  CASCADE
users     1──N notificaciones (notificaciones.user_id → users.id)          CASCADE
```

Todas las FK hacia `estudios`/`users` son `ON DELETE RESTRICT` (no se puede borrar un estudio o usuario referenciado). Solo `notificaciones` cascadea.

### Estados de impuesto y transiciones

Estados: `pendiente` (default) · `vencido` · `pagado`.

| Transición | Cómo ocurre | Disparador |
|---|---|---|
| `pendiente → pagado` | `PATCH /api/impuestos/:id/estado` | contador |
| `vencido → pagado` | `PATCH /api/impuestos/:id/estado` | contador (permitido: el endpoint solo bloquea si ya está `pagado`) |
| `pendiente → vencido` | Cron `procesarVencidos` cuando `fecha_vencimiento < hoy (ART)` | **solo el cron** |

- `pagado` es **terminal**: no se puede editar (`PATCH /:id` → 400) ni volver a marcar pagado (`PATCH /:id/estado` → 400).
- **No existe** transición `vencido → pendiente` ni `pagado → *` por ningún endpoint ni el cron.
- Editar un impuesto `vencido` está permitido (solo se bloquea `pagado`) y **no resetea el estado** aunque se mueva la fecha al futuro. Ver sección 4 (comportamiento no obvio).

---

## 3. Endpoints

Notas transversales:
- Body siempre JSON (`express.json()`). Content-Type `application/json`.
- Errores de validación / negocio devuelven `{ "error": "<mensaje>" }` con el status indicado.
- `500` siempre devuelve `{ "error": "Error interno del servidor" }` (se omite repetirlo en cada tabla salvo aclaración).
- Errores de auth comunes a **toda** ruta protegida con JWT:

| Status | Cuándo | Body |
|---|---|---|
| 401 | Falta header `Authorization` o no empieza con `Bearer ` | `{ "error": "Token requerido" }` |
| 401 | Token inválido o expirado | `{ "error": "Token inválido o expirado" }` |
| 403 | Token válido pero rol incorrecto para la ruta | `{ "error": "Sin permiso para esta acción" }` |

> `requireRole` también puede devolver `401 { "error": "No autenticado" }` si llega sin `req.user`, pero en la práctica `authenticate` corre antes en todas las rutas.

---

### 3.0 Health

#### `GET /health`
- **Rol:** público (sin auth).
- **Response 200:**
  ```json
  { "status": "ok", "timestamp": "2026-06-01T12:00:00.000Z" }
  ```
  > `timestamp` se serializa como un `Date` de JS (ISO-8601 en JSON).

---

### 3.1 Auth — `/api/auth`

#### `POST /api/auth/login`
- **Rol:** público. **Rate limit:** 10 requests / 15 min por IP (ver sección 4).
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `email` | string | sí | Debe estar presente y pasar `isValidEmail` (regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`, longitud ≤ 254). |
  | `password` | string | sí | Solo se valida presencia (no longitud). |
  | `remember` | boolean | no | Si es exactamente `true` → token a `10d`; cualquier otro valor → `8h`. |

- **Response 200:**
  ```json
  {
    "token": "<jwt>",
    "expires_at": "2026-06-01T20:00:00.000Z",
    "user": {
      "id": "uuid",
      "nombre": "string",
      "email": "string",
      "role": "admin|contador|cliente",
      "estudio_id": "uuid|null"
    }
  }
  ```
  > Nota: el `user` del login **no** incluye `cuit`, `telefono`, `activo` ni `created_at` (shape distinto al `User` de los demás endpoints).

- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | Falta `email` o `password` | `{ "error": "Email y password requeridos" }` |
  | 400 | `email` no pasa `isValidEmail` | `{ "error": "Email inválido" }` |
  | 401 | Email no existe **/** contraseña incorrecta **/** usuario inactivo (mismo mensaje para los tres, anti-enumeración) | `{ "error": "Credenciales inválidas" }` |
  | 429 | Excede el rate limit | `{ "error": "Demasiados intentos, intente de nuevo en 15 minutos" }` |
  | 500 | Error de DB / excepción | `{ "error": "Error interno del servidor" }` |

---

### 3.2 Admin — `/api/admin`

Todas requieren `Authorization: Bearer` + rol **admin** (`router.use(authenticate, requireRole('admin'))`).

#### `POST /api/admin/contadores`
- **Crea un contador.**
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `nombre` | string | sí | presencia |
  | `email` | string | sí | presencia + `isValidEmail` |
  | `password` | string | sí | longitud ≥ 8 |
  | `estudio_id` | string (uuid) | sí | el estudio debe existir y estar `activo` |

  > `role` se fuerza a `contador` y `activo` a `true`. No se aceptan del body.

- **Response 201:** objeto `User` (shape `USER_FIELDS`).
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | Falta algún campo obligatorio | `{ "error": "nombre, email, password y estudio_id son requeridos" }` |
  | 400 | Email inválido | `{ "error": "Email inválido" }` |
  | 400 | Password < 8 | `{ "error": "La contraseña debe tener al menos 8 caracteres" }` |
  | 409 | Email ya existe en `users` | `{ "error": "Email ya registrado" }` |
  | 400 | Estudio no existe o está inactivo | `{ "error": "Estudio no existe o está inactivo" }` |
  | 500 | Error de inserción | `{ "error": "Error interno del servidor" }` |

#### `GET /api/admin/contadores`
- **Lista todos los contadores** (`role = 'contador'`), ordenados por `created_at` desc.
- **Response 200:** `User[]`.
- **Errores:** 500.

#### `GET /api/admin/contadores/:id`
- **Obtiene un contador por id.**
- **Response 200:** `User`.
- **Errores:** `404 { "error": "Contador no encontrado" }` (si no existe o no es contador); 500.

#### `PATCH /api/admin/contadores/:id`
- **Actualiza nombre y/o email de un contador.**
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `nombre` | string | no | — |
  | `email` | string | no | si viene, `isValidEmail`; y único entre otros users |

- **Response 200:** `User` actualizado.
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `email` presente e inválido | `{ "error": "Email inválido" }` |
  | 404 | Contador no existe | `{ "error": "Contador no encontrado" }` |
  | 409 | `email` ya usado por otro user | `{ "error": "Email ya registrado" }` |
  | 400 | No se envió `nombre` ni `email` | `{ "error": "No se enviaron campos para actualizar" }` |
  | 500 | Error de update | `{ "error": "Error interno del servidor" }` |

  > **Orden de precedencia:** aquí el `404` (no existe) se evalúa **antes** que "no se enviaron campos". Esto difiere de `PATCH /api/clientes/:id` (ver nota allí).

#### `PATCH /api/admin/contadores/:id/estado`
- **Activa/desactiva un contador.**
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `activo` | boolean | sí | debe ser boolean (no `undefined`) |

- **Response 200:** `{ "message": "Estado actualizado", "activo": <boolean> }`.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `activo` ausente o no boolean | `{ "error": "activo (boolean) requerido" }` |
  | 404 | Contador no existe | `{ "error": "Contador no encontrado" }` |
  | 500 | Error de update | `{ "error": "Error interno del servidor" }` |

  > Desactivar un contador **no invalida sus JWT vigentes** (ver sección 4 / sección 5).

---

### 3.3 Clientes — `/api/clientes`

Todas requieren `Authorization: Bearer` + rol **contador** (`router.use(authenticate, requireRole('contador'))`).
**Multi-tenant:** todas las queries filtran por `estudio_id` del token. Un contador solo ve/opera clientes de su estudio.

#### `GET /api/clientes`
- **Lista los clientes del estudio** (`role = 'cliente'` + `estudio_id` del token), ordenados por `nombre` asc.
- **Response 200:** `User[]`.
- **Errores:** 500.

#### `POST /api/clientes`
- **Crea un cliente en el estudio del contador.**
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `nombre` | string | sí | presencia |
  | `email` | string | sí | presencia + `isValidEmail` |
  | `password` | string | sí | longitud ≥ 8 |
  | `cuit` | string | no | sin validación de formato; default `null` |
  | `telefono` | string | no | sin validación de formato; default `null` |

  > `role` se fuerza a `cliente`, `estudio_id` se toma del token, `activo` = `true`.

- **Response 201:** objeto `User`.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | Falta `nombre`, `email` o `password` | `{ "error": "nombre, email y password son requeridos" }` |
  | 400 | Email inválido | `{ "error": "Email inválido" }` |
  | 400 | Password < 8 | `{ "error": "La contraseña debe tener al menos 8 caracteres" }` |
  | 409 | Email ya registrado (global, en cualquier estudio) | `{ "error": "Email ya registrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `GET /api/clientes/:id`
- **Obtiene un cliente del estudio por id.**
- **Response 200:** `User`.
- **Errores:** `404 { "error": "Cliente no encontrado" }` (si no existe, no es cliente, o es de otro estudio); 500.

#### `PATCH /api/clientes/:id`
- **Actualiza datos de un cliente del estudio.**
- **Request body:** (todos opcionales, al menos uno requerido)

  | Campo | Tipo | Validación |
  |---|---|---|
  | `nombre` | string | — |
  | `email` | string | si viene, `isValidEmail` + único |
  | `cuit` | string | — |
  | `telefono` | string | — |

- **Response 200:** `User` actualizado.
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `email` presente e inválido | `{ "error": "Email inválido" }` |
  | 400 | No se envió ningún campo | `{ "error": "No se enviaron campos para actualizar" }` |
  | 404 | Cliente no existe en el estudio | `{ "error": "Cliente no encontrado" }` |
  | 409 | `email` ya usado por otro user | `{ "error": "Email ya registrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > **Incongruencia de orden vs. contadores:** acá "no se enviaron campos" (400) se evalúa **antes** que el `404` de inexistencia. En `PATCH /api/admin/contadores/:id` es al revés. Relevante si el frontend asume el mismo orden de errores en ambos recursos.

#### `PATCH /api/clientes/:id/estado`
- **Activa/desactiva un cliente del estudio.**
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `activo` | boolean | sí | debe ser boolean |

- **Response 200:** `{ "message": "Estado actualizado", "activo": <boolean> }`.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `activo` no es boolean | `{ "error": "activo debe ser boolean" }` |
  | 404 | Cliente no existe en el estudio | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > El mensaje difiere del de contadores (`"activo (boolean) requerido"` vs `"activo debe ser boolean"`).

#### `PATCH /api/clientes/:id/password`
- **Cambia la contraseña de un cliente del estudio** (acción del contador, no self-service).
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `password` | string | sí | string y longitud ≥ 8 |

- **Response 204:** sin body.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `password` no es string o < 8 | `{ "error": "La contraseña debe tener al menos 8 caracteres" }` |
  | 404 | Cliente no existe en el estudio | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > Cambiar la contraseña **no invalida** los JWT vigentes del cliente.

---

### 3.4 Impuestos — `/api/impuestos`

Auth aplicada **por ruta** (no a nivel router). Las rutas de cliente se registran **antes** que `/:id` para evitar colisión.
**Multi-tenant:** todas filtran por `estudio_id` del token.

#### `GET /api/impuestos/mis-impuestos`
- **Rol:** cliente.
- **Lista los impuestos del cliente logueado**, filtrados por `cliente_id = req.user.id` + `estudio_id` del token, agrupados por estado.
- **Response 200** (objeto, **no** array):
  ```json
  {
    "pendientes": [ /* Impuesto[] */ ],
    "vencidos":   [ /* Impuesto[] */ ],
    "pagados":    [ /* Impuesto[] */ ]
  }
  ```
  > Cada grupo está ordenado por `fecha_vencimiento` asc (orden global previo al split).
- **Errores:** 500.

#### `GET /api/impuestos/mis-impuestos/:id`
- **Rol:** cliente.
- **Obtiene un impuesto propio** por id (filtrado por `cliente_id` + `estudio_id`).
- **Response 200:** objeto `Impuesto`.
- **Errores:** `404 { "error": "Impuesto no encontrado" }` (si no existe o no es del cliente); 500.

#### `POST /api/impuestos`
- **Rol:** contador.
- **Crea un impuesto para un cliente de su estudio.**
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `cliente_id` | string (uuid) | sí | el cliente debe existir, ser `role = cliente` y del mismo `estudio_id` |
  | `tipo` | string | sí | longitud ≤ 100 |
  | `monto` | number | sí | `typeof number`, finito y `> 0` |
  | `fecha_vencimiento` | string | sí | formato exacto `YYYY-MM-DD` y fecha parseable. **No** se valida que sea futura. |
  | `descripcion` | string | no | default `null` |
  | `link_pago` | string | no | si viene, debe empezar con `https://` (case-insensitive) |

  > `estudio_id` y `creado_por` se toman del token. `estado` se fuerza a `pendiente`.

- **Response 201:** objeto `Impuesto` completo.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | Falta `cliente_id`, `tipo`, `monto` o `fecha_vencimiento` | `{ "error": "cliente_id, tipo, monto y fecha_vencimiento son requeridos" }` |
  | 400 | `tipo` > 100 chars | `{ "error": "El tipo no puede superar 100 caracteres" }` |
  | 400 | `monto` no numérico / no finito / ≤ 0 | `{ "error": "monto debe ser un número positivo" }` |
  | 400 | `fecha_vencimiento` con formato inválido | `{ "error": "Fecha de vencimiento debe tener formato YYYY-MM-DD" }` |
  | 400 | `link_pago` presente y no HTTPS | `{ "error": "link_pago debe ser una URL HTTPS válida" }` |
  | 404 | Cliente inexistente / de otro estudio / no es cliente | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de inserción | `{ "error": "Error interno del servidor" }` |

  > **Efecto secundario:** tras crear, intenta enviar email `sendNuevoImpuesto` al cliente y registra una notificación `tipo = 'nuevo'`. Si el email falla, se loguea pero **la request igual responde 201** (no rompe). El envío real depende de `EMAILS_ENABLED` (sección 4).

#### `GET /api/impuestos`
- **Rol:** contador.
- **Lista impuestos del estudio**, ordenados por `fecha_vencimiento` asc.
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `cliente_id` | string (uuid) | no | filtra por cliente. Sin validación de formato (filtro directo). |
  | `estado` | string | no | si viene, debe ser `pendiente`, `vencido` o `pagado` |

- **Response 200:** `Impuesto[]`.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `estado` con valor inválido | `{ "error": "estado debe ser pendiente, vencido o pagado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `GET /api/impuestos/:id`
- **Rol:** contador.
- **Obtiene un impuesto del estudio por id.**
- **Response 200:** `Impuesto`.
- **Errores:** `404 { "error": "Impuesto no encontrado" }`; 500.

#### `PATCH /api/impuestos/:id`
- **Rol:** contador.
- **Edita un impuesto del estudio** (mientras no esté `pagado`).
- **Request body:** (todos opcionales, al menos uno requerido)

  | Campo | Tipo | Validación |
  |---|---|---|
  | `tipo` | string | **No** se valida longitud aquí (a diferencia del create). `> 100` chars ⇒ rechazo a nivel DB ⇒ 500. |
  | `monto` | number | si viene, finito y `> 0` |
  | `fecha_vencimiento` | string | si viene, formato `YYYY-MM-DD` válido |
  | `descripcion` | string | — |
  | `link_pago` | string | si viene, debe empezar con `https://` |

- **Response 200:** `Impuesto` actualizado.
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `fecha_vencimiento` formato inválido | `{ "error": "Fecha de vencimiento debe tener formato YYYY-MM-DD" }` |
  | 400 | `monto` inválido | `{ "error": "monto debe ser un número positivo" }` |
  | 400 | `link_pago` no HTTPS | `{ "error": "link_pago debe ser una URL HTTPS válida" }` |
  | 400 | No se envió ningún campo | `{ "error": "No se enviaron campos para actualizar" }` |
  | 404 | Impuesto no existe en el estudio | `{ "error": "Impuesto no encontrado" }` |
  | 400 | Impuesto está `pagado` | `{ "error": "No se puede editar un impuesto pagado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > **Comportamiento no obvio:** un impuesto en estado `vencido` **sí** se puede editar, y editarlo **no** lo devuelve a `pendiente` aunque se mueva la fecha al futuro. Solo `pagado` bloquea la edición.

#### `PATCH /api/impuestos/:id/estado`
- **Rol:** contador.
- **Marca un impuesto como pagado.** No requiere body (no lee campos del body).
- **Response 200:** `Impuesto` actualizado con `estado = 'pagado'`, `pagado_at` (ISO ahora) y `pagado_por` (id del contador).
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 404 | Impuesto no existe en el estudio | `{ "error": "Impuesto no encontrado" }` |
  | 400 | Impuesto ya está `pagado` | `{ "error": "El impuesto ya está pagado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > La única transición que produce este endpoint es `→ pagado`. Funciona tanto desde `pendiente` como desde `vencido`.

---

### 3.5 Internal (cron trigger) — `/api/internal`

#### `POST /api/internal/run-cron`
- **Auth:** **no** JWT. Requiere header `x-cron-secret` que matchee `process.env.CRON_SECRET` (comparado con `crypto.timingSafeEqual`). Pensado para un scheduler externo.
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `job` | string | no | `vencidos`, `recordatorios` o `all`. Default: `all`. |

- **Response 200:**
  ```json
  { "status": "ok", "ran": ["vencidos", "recordatorios"] }
  ```
  > `ran` contiene los jobs efectivamente corridos según `job`.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 503 | `CRON_SECRET` no configurado en el server | `{ "error": "CRON_SECRET no configurado" }` |
  | 401 | Falta header `x-cron-secret` | `{ "error": "Header x-cron-secret requerido" }` |
  | 403 | Secret no coincide | `{ "error": "Secret inválido" }` |
  | 400 | `job` con valor inválido | `{ "error": "job debe ser 'vencidos', 'recordatorios' o 'all'" }` |
  | 500 | Excepción durante la corrida | `{ "error": "Error interno del servidor" }` |

---

## 4. Reglas de negocio

### Aislamiento multi-tenant

- **No se usa RLS.** El cliente de Supabase usa la **Service Role Key**, que bypassa Row Level Security. El aislamiento es 100% responsabilidad del backend.
- Mecanismo: cada query de un **contador** o **cliente** filtra por `estudio_id` tomado del JWT (`req.user.estudio_id`). Ejemplos: `listarClientes`, `crearImpuesto`, `misImpuestos`, etc. siempre agregan `.eq('estudio_id', ...)`.
- El **admin** no tiene estudio (`estudio_id = null`) y opera sobre contadores de forma global; al crear un contador, le asigna el `estudio_id` recibido en el body.
- Consecuencia para el contrato: un recurso de otro estudio responde **404** (no 403), porque el filtro `estudio_id` hace que la fila "no exista" para esa query.

### El cron de vencimientos

- Definido en `src/jobs/vencimientosCron.ts`, inicializado en `initCronJobs()` desde `src/index.ts` al arrancar el server.
- **Dos jobs, ambos a las `08:00` hora `America/Argentina/Buenos_Aires`** (cron expr `0 8 * * *`):
  1. **`procesarVencidos`** — busca impuestos `estado = 'pendiente'` con `fecha_vencimiento < hoy (ART)`. Para cada uno: si ya existe notificación `tipo = 'vencido'` lo saltea; si no, **cambia `estado → vencido`**, envía email `sendVencido` **al cliente** (`impuesto.cliente.email`) y registra notificación `vencido`.
  2. **`procesarRecordatorios`** — busca impuestos `estado = 'pendiente'` con `fecha_vencimiento = hoy + 3 días (ART)`. Para cada uno: si ya existe notificación `recordatorio_3dias` lo saltea; si no, envía `sendRecordatorio` al cliente y registra notificación `recordatorio_3dias`.
- **Cálculo de fechas:** "hoy" se obtiene con `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })` → `YYYY-MM-DD` en horario argentino.
- **Anti-duplicado:** tabla `notificaciones` deduplicada por `(impuesto_id, tipo)`.
- **Disparo manual / externo:** `POST /api/internal/run-cron` con header `x-cron-secret` (ver 3.5). Útil en entornos serverless donde `node-cron` no corre de forma confiable.
- **(verificar) — bug conocido en `procesarVencidos`:** el cambio de estado a `vencido` ocurre **antes** de enviar el email. Si el email falla, la notificación `vencido` **no** se inserta, pero el estado ya quedó en `vencido`; como la query del cron solo busca `estado = 'pendiente'`, ese impuesto **nunca se reintenta** y el email de vencimiento se pierde definitivamente.

### Feature flags

| Flag (env) | Default | Efecto |
|---|---|---|
| `EMAILS_ENABLED` | `false` | Solo si vale exactamente `'true'` se envían emails reales vía Resend. Con cualquier otro valor, las funciones de email loguean `SKIP` y retornan sin enviar (toda la lógica de notificaciones/negocio igual corre). |

- Emails (`src/services/emailService.ts`): `sendNuevoImpuesto`, `sendRecordatorio`, `sendVencido`. Los tres se envían **al email del cliente**. HTML escapado (`escapeHtml`), links solo si son `https://` (`safeHref`), montos en formato `ARS` (`Intl` es-AR), fechas `DD/MM/YYYY`. Remitente configurable con `EMAIL_FROM` (default `Sistema Contable <notificaciones@tudominio.com>`).

### Rate limiting

- Solo el login (`loginLimiter`): **10 requests / 15 minutos**, identificado por IP. Excedido ⇒ `429 { "error": "Demasiados intentos, intente de nuevo en 15 minutos" }`. Headers estándar `RateLimit-*` activados (`standardHeaders: true`, `legacyHeaders: false`).
- Ningún otro endpoint tiene rate limit.

### CORS

- Allowlist vía env `ALLOWED_ORIGINS` (CSV, se trimean los valores). Vacío por default ⇒ ningún origin de navegador permitido.
- Requests **sin** header `Origin` (ej. server-to-server, curl) **se permiten** (`!origin → callback(null, true)`).
- Origin no permitido ⇒ el middleware `cors` pasa un `Error` ⇒ lo maneja el error handler por default de Express. **(verificar)** el status exacto que llega al cliente (sin error handler custom, Express responde `500`).
- `credentials: true`.

### Variables de entorno

| Variable | Requerida | Uso |
|---|---|---|
| `JWT_SECRET` | sí | Firma/verificación de JWT |
| `SUPABASE_URL` | sí | Conexión Supabase |
| `SUPABASE_SERVICE_KEY` | sí | Service Role Key (bypassa RLS — secreto) |
| `RESEND_API_KEY` | sí | Cliente Resend |
| `CRON_SECRET` | no* | Autoriza `/api/internal/run-cron`. Sin esto el endpoint responde 503. |
| `PORT` | no | Puerto HTTP (default 3000) |
| `ALLOWED_ORIGINS` | no | CSV de orígenes CORS |
| `EMAIL_FROM` | no | Remitente de emails |
| `EMAILS_ENABLED` | no | Flag de envío real (default off) |

- En el arranque (`src/index.ts`), si falta alguna de las 4 requeridas el proceso **termina con error** — salvo `NODE_ENV=test`, donde se omite la validación.

### Comportamiento no obvio (resumen)

- `trust proxy = 1` seteado en `createApp()` — para que `req.ip` y el rate-limit funcionen detrás de un proxy/CDN.
- Acceder a un recurso de otro estudio devuelve **404**, no 403.
- Un JWT sigue siendo válido tras desactivar al usuario o cambiarle la contraseña (no hay revocación).
- `monto` y `cuit`/`telefono` no validan longitud/formato en update → un valor que viole el límite de la columna devuelve **500** (error de DB), no 400.
- El objeto `user` del login tiene menos campos que el `User` de los demás endpoints.
- El orden de evaluación de errores (400 "sin campos" vs 404 "no existe") difiere entre `PATCH contadores/:id` y `PATCH clientes/:id`.

---

## 5. Lo que NO está implementado

Funcionalidades ausentes, deshabilitadas o solo parcialmente presentes en el código:

- **Estudios:** la tabla `estudios` existe y se referencia, pero **no hay endpoints** para crear, listar, editar ni desactivar estudios. Deben gestionarse directamente en la base. El frontend no puede dar de alta un estudio vía API.
- **Alta de admin:** no hay endpoint de signup ni de creación de admin. El admin debe sembrarse manualmente en la DB (recordar el constraint `chk_estudio_por_role`: admin con `estudio_id = NULL`).
- **Logout / revocación de tokens:** no existe. Desactivar un usuario o cambiarle la contraseña **no** invalida sus JWT vigentes (siguen válidos hasta expirar: 8h o 10d).
- **Refresh token:** no hay. Cuando el token expira, el usuario debe volver a loguearse.
- **Self-service del usuario logueado:** un cliente no puede editar su propio perfil ni cambiar su propia contraseña (solo el contador cambia la contraseña del cliente). No hay cambio de contraseña para contadores ni admins vía API.
- **DELETE:** no hay endpoints de borrado en ningún recurso. La baja es lógica (`activo = false`) y solo para contadores y clientes; impuestos no tienen baja.
- **Notificaciones expuestas:** la tabla `notificaciones` no tiene endpoints de lectura; es solo interna para deduplicar.
- **Emails en producción:** `EMAILS_ENABLED` está en `false` por default; mientras no se setee a `'true'`, no se envía ningún email real.
- **Headers de seguridad:** no hay Helmet ni HSTS/CSP/X-Frame-Options configurados en el código (`DOCUMENTATION.md` lo marca como pendiente).
- **`runVencimientosCron()`** (en `vencimientosCron.ts`) es un wrapper exportado que solo llama a `procesarVencidos`; no lo usa ni el scheduler ni el endpoint interno (ambos llaman a `procesarVencidos`/`procesarRecordatorios` directamente). Código efectivamente sin uso. **(verificar)** si el frontend/otros consumidores lo referencian.
