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
| **contador** | obligatorio | ABM de **clientes** de su estudio + ABM de **impuestos** de su estudio (crear, generar borradores automáticos, listar, ver, editar, marcar pagado, cambiar contraseña de cliente) + ABM del **calendario de vencimientos** + **libro IVA / movimientos** (importar `.xlsx`, ABM de movimientos manuales). Todo acotado a su `estudio_id`. |
| **cliente** | obligatorio | Solo lectura de **sus propios** impuestos (`/mis-impuestos`, `/mis-impuestos/:id`) y de **su propio** libro IVA / movimientos (`/api/movimientos/mis-movimientos`, `/resumen`, `/tendencia`). |

- Cada rol está limitado a sus rutas vía `requireRole(...)`. Un rol que pega a una ruta de otro recibe **403** `Sin permiso para esta acción`.
- No existe endpoint para crear admins ni estudios: ambos deben sembrarse directamente en la base. Ver sección 6.

---

## 2. Modelo de datos

Fuente: `src/database/schema.sql`. Extensión `uuid-ossp`; todos los IDs son UUID v4 con default `uuid_generate_v4()`.

### Enums

| Enum | Valores |
|---|---|
| `role` | `admin`, `contador`, `cliente` |
| `estado_impuesto` | `pendiente`, `vencido`, `pagado`, `borrador` |
| `tipo_notificacion` | `nuevo`, `recordatorio_3dias`, `vencido` |
| `condicion_fiscal` | `monotributista`, `responsable_inscripto` |
| `obligacion` | `monotributo`, `iva`, `autonomos`, `ingresos_brutos`, `convenio_multilateral`, `empleadores_sicoss`, `casas_particulares` |
| `movimiento_tipo` | `compra`, `venta` |
| `movimiento_origen` | `importado`, `manual` |

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
| `cuit` | VARCHAR(13) | nullable en la columna. **Para clientes creados/editados vía API el backend lo exige y valida** (11 dígitos + dígito verificador módulo 11). Admin/contador sembrados en DB pueden tenerlo `null`. |
| `telefono` | VARCHAR(20) | nullable. Sin validación de formato en el backend. |
| `condicion_fiscal` | `condicion_fiscal` | nullable. `monotributista` o `responsable_inscripto`. `NULL` para admin/contador o cliente sin clasificar. |
| `categoria` | VARCHAR | nullable. Letra del monotributo; **solo referencia**, sin validación ni uso en la lógica. |
| `convenio_multilateral` | BOOLEAN | NOT NULL, default `false`. Impuesto opcional; aplica a ambas condiciones fiscales. |
| `empleadores_sicoss` | BOOLEAN | NOT NULL, default `false`. Impuesto opcional; **solo** `responsable_inscripto` (la API rechaza `true` en monotributistas). |
| `casas_particulares` | BOOLEAN | NOT NULL, default `false`. Impuesto opcional; **solo** `responsable_inscripto` (la API rechaza `true` en monotributistas). |
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
  "condicion_fiscal": "monotributista|responsable_inscripto|null",
  "categoria": "string|null",
  "convenio_multilateral": false,
  "empleadores_sicoss": false,
  "casas_particulares": false,
  "telefono": "string|null",
  "activo": true,
  "created_at": "ISO-8601"
}
```
> El objeto `user` del **login** ahora devuelve **este mismo shape completo** (todas las columnas menos `password_hash`); ya **no** es un subconjunto. Para admin/contador `condicion_fiscal` y `categoria` son `null`. Ver endpoint de login.

### Tabla `impuestos`

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `estudio_id` | UUID | NOT NULL, FK → `estudios(id)` RESTRICT |
| `cliente_id` | UUID | NOT NULL, FK → `users(id)` RESTRICT |
| `creado_por` | UUID | NOT NULL, FK → `users(id)` RESTRICT (el contador que lo creó) |
| `tipo` | VARCHAR(100) | NOT NULL |
| `monto` | DECIMAL(12,2) | **nullable** (ver `chk_monto_por_estado`). Un borrador puede tener `monto NULL`; en cualquier otro estado es obligatorio y `> 0`. |
| `fecha_vencimiento` | DATE | NOT NULL. Formato `YYYY-MM-DD`. |
| `descripcion` | TEXT | nullable |
| `vep` | VARCHAR | nullable. Código VEP del pago (se carga vía `PATCH /:id`). |
| `obligacion` | `obligacion` | nullable. Seteada por la generación automática; `NULL` = impuesto **manual** (creado por `POST /api/impuestos`). |
| `periodo` | DATE | nullable. Primer día del mes declarado (`YYYY-MM-01`) en los generados; `NULL` = manual. |
| `estado` | `estado_impuesto` | NOT NULL, default `pendiente` |
| `pagado_at` | TIMESTAMPTZ | nullable |
| `pagado_por` | UUID | nullable, FK → `users(id)` RESTRICT |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default `NOW()`. Trigger `trg_impuestos_updated_at` lo actualiza en cada UPDATE. |

- **Constraint `chk_monto_por_estado`:** si `estado <> 'borrador'` ⇒ `monto IS NOT NULL AND monto > 0`; si `estado = 'borrador'` ⇒ `monto` puede ser `NULL`.
- **Constraint `chk_pagado_completo`:** `estado = 'pagado'` ⇒ `pagado_at` y `pagado_por` NOT NULL; `estado != 'pagado'` ⇒ ambos NULL.
- **Índice único `uq_impuestos_obligacion_periodo` `(cliente_id, obligacion, periodo)`:** anti-duplicado de la generación automática. Es `NULLS DISTINCT` (default), así los impuestos manuales (`obligacion`/`periodo` `NULL`) **no** colisionan y un cliente puede tener muchos.
- **Shape de respuesta:** `select('*')` → devuelve **todas** las columnas de arriba (incluidas `vep`, `obligacion`, `periodo`).
- **(verificar)** `monto` se tipa como `number` (no nullable) en la interfaz `Impuesto` de TypeScript, pero la DB lo permite `NULL` en borradores → la respuesta real puede traer `monto: null`. Además PostgREST/Supabase puede serializar `DECIMAL` como número o string según configuración; confirmar contra lo que parsea el frontend. Las columnas `obligacion` y `periodo` viajan en el JSON (`select('*')`) aunque **no** estén en la interfaz `Impuesto`.

### Tabla `vencimientos`

Calendario impositivo que carga el contador. Endpoints en sección 3.6.

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `estudio_id` | UUID | NOT NULL, FK → `estudios(id)` RESTRICT |
| `obligacion` | `obligacion` | NOT NULL |
| `terminacion_cuit` | SMALLINT | nullable, CHECK `0–9`. `NULL` = "todos" (no se discrimina por último dígito). |
| `anio` | INT | NOT NULL |
| `mes` | SMALLINT | NOT NULL, CHECK `1–12` |
| `fecha_vencimiento` | DATE | NOT NULL. Formato `YYYY-MM-DD`. |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `NOW()` |

- **Constraint `uq_vencimientos`** `UNIQUE NULLS NOT DISTINCT (estudio_id, obligacion, terminacion_cuit, anio, mes)`: en PG15+ la fila "todos" (`terminacion_cuit NULL`) tampoco se duplica (clave para la idempotencia del `PUT`).

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

### Tabla `movimientos`

Libro IVA (compras/ventas) de un cliente por período. Se puebla por **importación** de un `.xlsx` (`origen = 'importado'`) o **carga manual** (`origen = 'manual'`). Endpoints en sección 3.7.

| Columna | Tipo | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `estudio_id` | UUID | NOT NULL, FK → `estudios(id)` RESTRICT |
| `cliente_id` | UUID | NOT NULL, FK → `users(id)` RESTRICT |
| `tipo` | `movimiento_tipo` | NOT NULL. `compra` o `venta`. |
| `periodo` | DATE | NOT NULL. Primer día del mes del libro (`YYYY-MM-01`). **Separado de `fecha`**: el comprobante puede caer en otro mes que el período del libro. |
| `fecha` | DATE | NOT NULL. Fecha del comprobante (`YYYY-MM-DD`). |
| `tipo_comprobante` | TEXT | nullable |
| `letra` | TEXT | nullable |
| `numero` | TEXT | nullable |
| `contraparte` | TEXT | nullable |
| `cuit_contraparte` | TEXT | nullable. **No** se valida formato/dígito verificador (texto libre). |
| `neto` | NUMERIC(15,2) | nullable |
| `concepto_no_gravado` | NUMERIC(15,2) | **NOT NULL, default `0`** |
| `iva` | NUMERIC(15,2) | nullable |
| `acrecentamiento` | NUMERIC(15,2) | **NOT NULL, default `0`** |
| `total` | NUMERIC(15,2) | **NOT NULL**. Puede ser negativo (notas de crédito). |
| `retenciones_percepciones` | NUMERIC(15,2) | nullable |
| `op_exentas` | NUMERIC(15,2) | nullable |
| `origen` | `movimiento_origen` | NOT NULL. `importado` o `manual`. |
| `creado_por` | UUID | nullable, FK → `users(id)` RESTRICT (el contador que lo cargó/importó) |
| `created_at` | TIMESTAMPTZ | NOT NULL, default `now()` |

- **Índice `idx_movimientos_libro`** sobre `(estudio_id, cliente_id, tipo, periodo)`: query del libro de un cliente por mes; también soporta el reemplazo atómico de importados en la re-subida.
- **Sin constraint de positividad sobre los montos:** el backend tampoco valida positividad (notas de crédito / negativos son válidos). Solo `total` es obligatorio (number finito).
- **Función SQL `reemplazar_movimientos_importados(p_estudio_id, p_cliente_id, p_tipo, p_periodo, p_creado_por, p_registros jsonb) RETURNS jsonb`** (migración `005`): borra los `origen = 'importado'` previos del mismo libro/período e inserta los nuevos en **una sola transacción** (reemplazo atómico). Fija el contexto (`estudio_id`/`cliente_id`/`tipo`/`periodo`/`creado_por`/`origen='importado'`) desde sus parámetros, no del jsonb. Devuelve `{ "borrados": n, "insertados": m }`. **(verificar)** que la migración `005` esté aplicada en el entorno destino (se aplica a mano en Supabase).

**Shape de `Movimiento` que devuelven los endpoints de CRUD manual** (campos `MOVIMIENTO_FIELDS` — todas las columnas):
```json
{
  "id": "uuid",
  "estudio_id": "uuid",
  "cliente_id": "uuid",
  "tipo": "compra|venta",
  "periodo": "2026-04-01",
  "fecha": "2026-04-05",
  "tipo_comprobante": "string|null",
  "letra": "string|null",
  "numero": "string|null",
  "contraparte": "string|null",
  "cuit_contraparte": "string|null",
  "neto": "number|null",
  "concepto_no_gravado": 0,
  "iva": "number|null",
  "acrecentamiento": 0,
  "total": 121,
  "retenciones_percepciones": "number|null",
  "op_exentas": "number|null",
  "origen": "importado|manual",
  "creado_por": "uuid|null",
  "created_at": "ISO-8601"
}
```
> **(verificar)** los `NUMERIC` pueden serializarse como número o string según PostgREST/Supabase (igual que `monto` en `impuestos`); confirmar contra lo que parsea el frontend.

### Relaciones

```
estudios 1──N users        (users.estudio_id → estudios.id)
estudios 1──N impuestos     (impuestos.estudio_id → estudios.id)
estudios 1──N vencimientos  (vencimientos.estudio_id → estudios.id)
users    1──N impuestos     (impuestos.cliente_id → users.id)   [el cliente]
users    1──N impuestos     (impuestos.creado_por → users.id)   [el contador]
users    1──N impuestos     (impuestos.pagado_por → users.id)   [quien marcó pagado]
impuestos 1──N notificaciones (notificaciones.impuesto_id → impuestos.id)  CASCADE
users     1──N notificaciones (notificaciones.user_id → users.id)          CASCADE
estudios 1──N movimientos    (movimientos.estudio_id → estudios.id)
users    1──N movimientos    (movimientos.cliente_id → users.id)   [el cliente]
users    1──N movimientos    (movimientos.creado_por → users.id)   [el contador]
```

Todas las FK hacia `estudios`/`users` son `ON DELETE RESTRICT` (no se puede borrar un estudio o usuario referenciado). Solo `notificaciones` cascadea.

### Estados de impuesto y transiciones

Estados: `borrador` · `pendiente` (default) · `vencido` · `pagado`.

Ciclo de vida típico de un impuesto generado: **`borrador`** (sin monto, lo crea la generación automática) **→** (el contador le carga un `monto` válido) **`pendiente`** **→** `vencido` (cron) / `pagado`. Los impuestos manuales (`POST /api/impuestos`) nacen directamente en `pendiente`.

| Transición | Cómo ocurre | Disparador |
|---|---|---|
| `(alta) → borrador` | `POST /api/impuestos/generar` (con `monto NULL`) | contador |
| `borrador → pendiente` | `PATCH /api/impuestos/:id` cuando el impuesto queda con `monto` válido (`> 0`) | contador |
| `pendiente → pagado` | `PATCH /api/impuestos/:id/estado` | contador |
| `vencido → pagado` | `PATCH /api/impuestos/:id/estado` | contador (permitido: el endpoint solo bloquea si ya está `pagado`) |
| `pendiente → vencido` | Cron `procesarVencidos` cuando `fecha_vencimiento < hoy (ART)` | **solo el cron** |

- Un `borrador` **es editable** (`PATCH /:id`) y se completa cargándole datos. Mientras siga sin `monto > 0`, permanece en `borrador` (no se puede forzar `pendiente` sin monto: lo impide `chk_monto_por_estado`).
- `pagado` es **terminal**: no se puede editar (`PATCH /:id` → 400) ni volver a marcar pagado (`PATCH /:id/estado` → 400).
- **No existe** transición `pendiente/vencido → borrador`, `vencido → pendiente` ni `pagado → *` por ningún endpoint ni el cron.
- Editar un impuesto `vencido` está permitido (solo se bloquea `pagado`) y **no resetea el estado** aunque se mueva la fecha al futuro. Ver sección 4 (comportamiento no obvio).
- El cron (`procesarVencidos`) solo mira `estado = 'pendiente'`, así que **un `borrador` nunca vence** por más que pase su `fecha_vencimiento`.

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
| 401 | Usuario desactivado (o borrado) con token vigente | `{ "error": "Cuenta desactivada" }` |
| 401 | Estudio del usuario desactivado | `{ "error": "Estudio desactivado" }` |
| 403 | Token válido pero rol incorrecto para la ruta | `{ "error": "Sin permiso para esta acción" }` |
| 500 | Falla el lookup de `activo` en DB (fail-closed) | `{ "error": "Error interno del servidor" }` |

> `requireRole` también puede devolver `401 { "error": "No autenticado" }` si llega sin `req.user`, pero en la práctica `authenticate` corre antes en todas las rutas.
> **Revocación:** `authenticate` verifica la firma del JWT **y además** consulta en DB que el usuario y su estudio sigan `activo = true` (`src/middleware/userStatus.ts`). Desactivar un usuario o un estudio corta las sesiones vivas en el siguiente request.

- **Errores fuera de los controllers** (Multer, CORS, body malformado) los convierte a JSON el error handler global (`src/middleware/errorHandler.ts`, registrado al final del pipeline en `createApp`):

| Status | Cuándo | Body |
|---|---|---|
| 400 | Archivo subido supera el límite de Multer (5MB) | `{ "error": "El archivo supera el tamaño máximo permitido (5MB)" }` |
| 400 | Otro `MulterError` | `{ "error": "Error al procesar el archivo: <code>" }` |
| 400 | JSON malformado en el body (`express.json()`) | `{ "error": "JSON malformado en el body" }` |
| 403 | Origin rechazado por CORS | `{ "error": "CORS: origen no permitido" }` |
| 413 | Body excede el límite de `express.json()` | `{ "error": "Body demasiado grande" }` |
| 500 | Cualquier otro error no manejado | `{ "error": "Error interno del servidor" }` (sin stack trace, siempre JSON) |

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
      "estudio_id": "uuid|null",
      "nombre": "string",
      "email": "string",
      "role": "admin|contador|cliente",
      "cuit": "string|null",
      "telefono": "string|null",
      "condicion_fiscal": "monotributista|responsable_inscripto|null",
      "categoria": "string|null",
      "activo": true,
      "created_at": "ISO-8601"
    }
  }
  ```
  > Nota: el `user` del login devuelve el **objeto `User` completo** — todas las columnas de la fila menos `password_hash` (el login hace `select('*')` y descarta el hash). Antes era un subconjunto; ahora coincide con el `User` de los demás endpoints e incluye `condicion_fiscal`/`categoria` (`null` para admin/contador). El orden de claves sigue el de columnas de la tabla.

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
  | `condicion_fiscal` | string | **sí** | debe ser `monotributista` o `responsable_inscripto` |
  | `cuit` | string | **sí** | 11 dígitos + dígito verificador (módulo 11). Acepta separadores (espacios, `.`, `-`); se **normaliza** a 11 dígitos antes de guardar. |
  | `categoria` | string | no | sin validación; default `null`. Letra del monotributo (solo referencia). |
  | `convenio_multilateral` | boolean | no | default `false`. Impuesto opcional; válido para ambas condiciones. |
  | `empleadores_sicoss` | boolean | no | default `false`. Impuesto opcional; `true` solo si `condicion_fiscal = responsable_inscripto`. |
  | `casas_particulares` | boolean | no | default `false`. Impuesto opcional; `true` solo si `condicion_fiscal = responsable_inscripto`. |
  | `telefono` | string | no | sin validación de formato; default `null` |

  > `role` se fuerza a `cliente`, `estudio_id` se toma del token, `activo` = `true`. `cuit` se guarda **normalizado** (solo dígitos).

- **Response 201:** objeto `User` (incluye `condicion_fiscal` y `categoria`).
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | Falta `nombre`, `email` o `password` | `{ "error": "nombre, email y password son requeridos" }` |
  | 400 | Email inválido | `{ "error": "Email inválido" }` |
  | 400 | Password < 8 | `{ "error": "La contraseña debe tener al menos 8 caracteres" }` |
  | 400 | `condicion_fiscal` ausente o con valor inválido | `{ "error": "condicion_fiscal inválida" }` |
  | 400 | `cuit` ausente o inválido (formato/dígito verificador) | `{ "error": "CUIT inválido" }` |
  | 400 | Flag opcional no booleano | `{ "error": "<flag> debe ser boolean" }` |
  | 400 | Monotributista con `empleadores_sicoss`/`casas_particulares` en `true` | `{ "error": "empleadores_sicoss y casas_particulares solo aplican a responsable_inscripto" }` |
  | 409 | Email ya registrado (global, en cualquier estudio) | `{ "error": "Email ya registrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > Ojo: `condicion_fiscal` y `cuit` son obligatorios pero **no** figuran en el mensaje `"nombre, email y password son requeridos"`; si faltan, el rechazo llega por su validación específica (`"condicion_fiscal inválida"` / `"CUIT inválido"`).

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
  | `condicion_fiscal` | string | si viene, `monotributista` o `responsable_inscripto` |
  | `cuit` | string | si viene, 11 dígitos + dígito verificador (módulo 11); se normaliza antes de guardar |
  | `categoria` | string\|null | — (acepta `null` para limpiarlo) |
  | `convenio_multilateral` | boolean | si viene, boolean |
  | `empleadores_sicoss` | boolean | si viene, boolean; `true` solo con condición efectiva `responsable_inscripto` |
  | `casas_particulares` | boolean | si viene, boolean; `true` solo con condición efectiva `responsable_inscripto` |
  | `telefono` | string | — |

  > **Coherencia flags ↔ condición:** la condición "efectiva" es la del body o, si no viene, la guardada. Si la condición efectiva es `monotributista`, mandar `empleadores_sicoss`/`casas_particulares` en `true` da 400; y si la condición **pasa a** `monotributista` sin mandar los flags, el backend los **limpia solo** (los setea en `false`) para no dejar flags huérfanos.

- **Response 200:** `User` actualizado.
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `email` presente e inválido | `{ "error": "Email inválido" }` |
  | 400 | `condicion_fiscal` presente e inválida | `{ "error": "condicion_fiscal inválida" }` |
  | 400 | `cuit` presente e inválido | `{ "error": "CUIT inválido" }` |
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
- **Lista los impuestos del cliente logueado**, filtrados por `cliente_id = req.user.id` + `estudio_id` del token, agrupados por estado. **Excluye los `borrador`** (el cliente no ve los borradores): la query hace `.neq('estado', 'borrador')`.
- **Response 200** (objeto, **no** array):
  ```json
  {
    "pendientes": [ /* Impuesto[] */ ],
    "vencidos":   [ /* Impuesto[] */ ],
    "pagados":    [ /* Impuesto[] */ ]
  }
  ```
  > Cada grupo está ordenado por `fecha_vencimiento` asc (orden global previo al split). No hay grupo de borradores: nunca se devuelven al cliente.
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
  | `vep` | string | no | si viene, debe ser string y ≤ 100 chars. Se **trimea**; `""` ⇒ `null`. Default `null`. |

  > `estudio_id` y `creado_por` se toman del token. `estado` se fuerza a `pendiente` (este endpoint **nunca** crea borradores; `monto` es obligatorio). Los impuestos así creados son **manuales**: `obligacion` y `periodo` quedan `NULL`. Para los generados automáticamente ver `POST /api/impuestos/generar`.

- **Response 201:** objeto `Impuesto` completo.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | Falta `cliente_id`, `tipo`, `monto` o `fecha_vencimiento` | `{ "error": "cliente_id, tipo, monto y fecha_vencimiento son requeridos" }` |
  | 400 | `tipo` > 100 chars | `{ "error": "El tipo no puede superar 100 caracteres" }` |
  | 400 | `monto` no numérico / no finito / ≤ 0 | `{ "error": "monto debe ser un número positivo" }` |
  | 400 | `fecha_vencimiento` con formato inválido | `{ "error": "Fecha de vencimiento debe tener formato YYYY-MM-DD" }` |
  | 400 | `vep` no es string | `{ "error": "vep debe ser un string" }` |
  | 400 | `vep` > 100 chars (tras trim) | `{ "error": "vep no puede superar 100 caracteres" }` |
  | 404 | Cliente inexistente / de otro estudio / no es cliente | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de inserción | `{ "error": "Error interno del servidor" }` |

  > **Efecto secundario:** tras crear, intenta enviar email `sendNuevoImpuesto` al cliente y registra una notificación `tipo = 'nuevo'`. Si el email falla, se loguea pero **la request igual responde 201** (no rompe). El envío real depende de `EMAILS_ENABLED` (sección 4).

#### `POST /api/impuestos/generar`
- **Rol:** contador.
- **Genera en lote los impuestos mensuales en estado `borrador`** para los clientes del estudio, según su `condicion_fiscal` y el calendario de `vencimientos`. Cada borrador nace **sin `monto`** (`monto = null`); el contador luego le carga el importe con `PATCH /:id` (lo que lo pasa a `pendiente`).
- **Request body:** (ambos opcionales)

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `anio` | number | no | si viene, entero entre **2024 y 2100**. Si falta, usa el **año actual** del server. |
  | `mes` | number | no | si viene, entero entre **1 y 12**. Si falta, usa el **mes actual** del server. |

  > El `periodo` de los impuestos se arma como `YYYY-MM-01` a partir de `anio`/`mes`. El "actual" sale de `new Date()` del server (hora local del proceso, **no** ART). **(verificar)** la zona horaria del server si el default de `mes` es sensible al borde de mes.

- **Qué genera (lógica):**
  - Toma los clientes **activos** del estudio (`role = cliente`, `activo = true`).
  - Obligaciones por condición fiscal: `monotributista` → `monotributo`, `ingresos_brutos`; `responsable_inscripto` → `iva`, `autonomos`, `ingresos_brutos`.
  - **Obligaciones opcionales por flags del cliente** (columnas boolean en `users`): `convenio_multilateral` (ambas condiciones), `empleadores_sicoss` y `casas_particulares` (solo `responsable_inscripto`; la generación además lo chequea por defensa). Se suman a las de la condición.
  - La fecha de vencimiento de cada obligación sale del calendario (`vencimientos`) de ese `(anio, mes)`. Para `iva`, `autonomos`, `convenio_multilateral` y `empleadores_sicoss` se busca por **último dígito del CUIT** (`terminacion_cuit`); el resto (`monotributo`, `ingresos_brutos`, `casas_particulares`) se busca con `terminacion_cuit = null` ("todos").
  - La columna `tipo` se guarda con etiqueta legible: `Monotributo`, `IVA`, `Autónomos`, `Ingresos Brutos`.
  - **Idempotente:** upsert con `ON CONFLICT DO NOTHING` sobre `(cliente_id, obligacion, periodo)`. Correrlo dos veces para el mismo período no duplica; lo ya existente cuenta como `ya_existentes`.
- **Se saltea / reporta (no crea, pero no es error):**
  - Cliente sin `condicion_fiscal` → entra en `clientes_salteados` con `motivo: "Sin condición fiscal"`.
  - Cliente con CUIT inválido (no pasa validación módulo 11) → `clientes_salteados` con `motivo: "CUIT inválido"`.
  - Obligación sin fecha cargada en el calendario para ese `(anio, mes[, terminacion])` → entra en `obligaciones_sin_fecha` (no se crea ese impuesto).
- **Response 200:**
  ```json
  {
    "anio": 2026,
    "mes": 6,
    "creados": 12,
    "ya_existentes": 3,
    "clientes_salteados": [
      { "cliente_id": "uuid", "nombre": "string", "motivo": "Sin condición fiscal" }
    ],
    "obligaciones_sin_fecha": [
      { "cliente_id": "uuid", "nombre": "string", "obligacion": "iva" }
    ]
  }
  ```
  > `creados` = filas realmente insertadas; `ya_existentes` = filas que ya existían (candidatas menos creadas). Devuelve **200**, no 201.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > **No** envía emails ni registra notificaciones (a diferencia de `POST /api/impuestos`): los borradores son internos del contador hasta que se completan.

#### `GET /api/impuestos`
- **Rol:** contador.
- **Lista impuestos del estudio**, ordenados por `fecha_vencimiento` asc.
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `cliente_id` | string (uuid) | no | filtra por cliente. Sin validación de formato (filtro directo). |
  | `estado` | string | no | si viene, debe ser `pendiente`, `vencido` o `pagado` (**no** acepta `borrador`) |

- **Response 200:** `Impuesto[]`. **Sin filtro `estado`, la lista incluye los `borrador`** (el contador sí los ve). Para aislarlos no hay valor de filtro: `estado=borrador` devuelve 400.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `estado` con valor inválido (incluye `borrador`) | `{ "error": "estado debe ser pendiente, vencido o pagado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `GET /api/impuestos/:id`
- **Rol:** contador.
- **Obtiene un impuesto del estudio por id.**
- **Response 200:** `Impuesto`.
- **Errores:** `404 { "error": "Impuesto no encontrado" }`; 500.

#### `PATCH /api/impuestos/:id`
- **Rol:** contador.
- **Edita un impuesto del estudio** (mientras no esté `pagado`). También es el endpoint para **completar un borrador** (cargarle `monto`/`vep`).
- **Request body:** (todos opcionales, al menos uno requerido)

  | Campo | Tipo | Validación |
  |---|---|---|
  | `tipo` | string | **No** se valida longitud aquí (a diferencia del create). `> 100` chars ⇒ rechazo a nivel DB ⇒ 500. |
  | `monto` | number | si viene, finito y `> 0` |
  | `fecha_vencimiento` | string | si viene, formato `YYYY-MM-DD` válido |
  | `descripcion` | string | — |
  | `vep` | string | si viene, debe ser string y ≤ 100 chars. Se **trimea**; string vacío `""` ⇒ guarda `null` (permite limpiarlo). |

- **Response 200:** `Impuesto` actualizado.
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `fecha_vencimiento` formato inválido | `{ "error": "Fecha de vencimiento debe tener formato YYYY-MM-DD" }` |
  | 400 | `monto` inválido | `{ "error": "monto debe ser un número positivo" }` |
  | 400 | `vep` no es string | `{ "error": "vep debe ser un string" }` |
  | 400 | `vep` > 100 chars (tras trim) | `{ "error": "vep no puede superar 100 caracteres" }` |
  | 400 | No se envió ningún campo | `{ "error": "No se enviaron campos para actualizar" }` |
  | 404 | Impuesto no existe en el estudio | `{ "error": "Impuesto no encontrado" }` |
  | 400 | Impuesto está `pagado` | `{ "error": "No se puede editar un impuesto pagado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > **Completar borrador (transición automática):** si el impuesto está en `borrador` y tras el PATCH queda con `monto` válido (`> 0` — sea el del body o el ya guardado), el backend setea automáticamente `estado = 'pendiente'`. Si sigue sin `monto > 0`, permanece en `borrador` (forzar `pendiente` sin monto violaría `chk_monto_por_estado`). No hay forma de mandar `estado` explícito en el body.
  > **Comportamiento no obvio:** un impuesto en estado `vencido` **sí** se puede editar, y editarlo **no** lo devuelve a `pendiente` aunque se mueva la fecha al futuro. Solo `pagado` bloquea la edición; los `borrador` son editables.

#### `PATCH /api/impuestos/:id/estado`
- **Rol:** contador.
- **Marca un impuesto como pagado.** No requiere body (no lee campos del body).
- **Response 200:** `Impuesto` actualizado con `estado = 'pagado'`, `pagado_at` (ISO ahora) y `pagado_por` (id del contador).
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 404 | Impuesto no existe en el estudio | `{ "error": "Impuesto no encontrado" }` |
  | 400 | Impuesto ya está `pagado` | `{ "error": "El impuesto ya está pagado" }` |
  | 400 | Impuesto está en `borrador` | `{ "error": "Un borrador no se puede cambiar de estado; cargá el monto para pasarlo a pendiente" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

  > La única transición que produce este endpoint es `→ pagado`. Funciona tanto desde `pendiente` como desde `vencido`. Sobre un `borrador` se rechaza con **400** `{ "error": "Un borrador no se puede cambiar de estado; cargá el monto para pasarlo a pendiente" }` (guard antes de tocar la DB): un borrador solo pasa a `pendiente` vía `PATCH /:id` al cargarle el monto.

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

### 3.6 Vencimientos — `/api/vencimientos`

Auth aplicada **por ruta** + rol **contador** (`authenticate, requireRole('contador')` en cada handler).
**Multi-tenant:** todas las rutas filtran/escriben por `estudio_id` del token. El `estudio_id` del body, si viene, **se ignora**. Un recurso de otro estudio responde **404**.

Calendario impositivo que carga el contador. El backend almacena/devuelve por dígito individual (`terminacion_cuit` 0–9) o `null` (= "todos"); **no** expande grupos (eso es del frontend).

**Shape de `Vencimiento` que devuelven los endpoints** (campos `VENCIMIENTO_FIELDS`):
```json
{
  "id": "uuid",
  "estudio_id": "uuid",
  "obligacion": "monotributo|iva|autonomos|ingresos_brutos|convenio_multilateral|empleadores_sicoss|casas_particulares",
  "terminacion_cuit": 0,
  "anio": 2026,
  "mes": 6,
  "fecha_vencimiento": "2026-06-15",
  "created_at": "ISO-8601"
}
```
> `terminacion_cuit` es `number (0–9)` o `null` (= "todos", p. ej. monotributo).

#### `GET /api/vencimientos`
- **Rol:** contador.
- **Lista los vencimientos del estudio** para un año (y obligación si se filtra), ordenados por `obligacion` asc, `mes` asc, `terminacion_cuit` asc (nulls first).
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `anio` | number | no | si viene, entero entre **2024 y 2100**. Si falta, usa el **año actual** del server. |
  | `obligacion` | string | no | si viene, debe ser `monotributo`, `iva`, `autonomos`, `ingresos_brutos`, `convenio_multilateral`, `empleadores_sicoss` o `casas_particulares` |

- **Response 200:** `Vencimiento[]`.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `obligacion` con valor inválido | `{ "error": "obligacion debe ser una de: monotributo, iva, autonomos, ingresos_brutos, convenio_multilateral, empleadores_sicoss, casas_particulares" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `PUT /api/vencimientos`
- **Rol:** contador.
- **Reemplazo declarativo del calendario de UN año** (función `reemplazarVencimientosAnio`). Tres pasos:
  1. **Upsert** de las `entries` recibidas (`estudio_id` del token; `onConflict` sobre `(estudio_id, obligacion, terminacion_cuit, anio, mes)`). Se omite si `entries` está vacío.
  2. **Select** de todas las filas existentes del `(estudio_id, anio)`.
  3. **Delete** de las filas del año que **no** estén declaradas en `entries` (así vaciar una celda en la UI borra la fecha en DB). `entries: []` limpia el año completo.

  > No es atómico (PostgREST sin transacción): si falla después del upsert, lo declarado ya quedó persistido y a lo sumo sobran filas viejas (el próximo `PUT` las limpia).

- **Request body:**
  ```json
  {
    "anio": 2026,
    "entries": [
      { "obligacion": "iva", "terminacion_cuit": 3, "anio": 2026, "mes": 6, "fecha_vencimiento": "2026-06-18" },
      { "obligacion": "monotributo", "terminacion_cuit": null, "anio": 2026, "mes": 6, "fecha_vencimiento": "2026-06-20" }
    ]
  }
  ```

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `anio` (body) | number | sí | entero entre **2024 y 2100**; define el año a reemplazar |
  | `entries` | array | sí | puede ser `[]` (= limpiar el año); máx **500** |

  | Campo (por entry) | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `obligacion` | string | sí | `monotributo`, `iva`, `autonomos`, `ingresos_brutos`, `convenio_multilateral`, `empleadores_sicoss` o `casas_particulares` |
  | `terminacion_cuit` | number\|null | sí* | `null` (= "todos") o entero **0–9**. `undefined` se trata como `null`. |
  | `anio` | number | sí | entero entre **2024 y 2100** y **debe coincidir** con el `anio` del body |
  | `mes` | number | sí | entero entre **1 y 12** |
  | `fecha_vencimiento` | string | sí | formato exacto `YYYY-MM-DD` y fecha parseable |

  > `estudio_id` en el body **se ignora** (se fuerza desde el token).
  > Las entries se **deduplican por clave de conflicto** antes del upsert (conserva la última ocurrencia) para no violar el `ON CONFLICT` de Postgres.

- **Response 200:**
  ```json
  {
    "count": 2,
    "deleted": 1,
    "data": [ /* Vencimiento[] */ ]
  }
  ```
  > `count` = filas upserteadas (tras dedup). `deleted` = filas del año eliminadas por no estar declaradas. `data` = filas upserteadas con `VENCIMIENTO_FIELDS` (`[]` si `entries` vacío).

- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `anio` del body falta, no es entero o fuera de rango | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `entries` no es array | `{ "error": "entries debe ser un array" }` |
  | 400 | `entries` supera **500** elementos | `{ "error": "entries no puede superar 500 elementos" }` |
  | 400 | `obligacion` inválida en `entries[i]` | `{ "error": "entries[i].obligacion debe ser una de: monotributo, iva, autonomos, ingresos_brutos, convenio_multilateral, empleadores_sicoss, casas_particulares" }` |
  | 400 | `terminacion_cuit` inválido en `entries[i]` | `{ "error": "entries[i].terminacion_cuit debe ser null o un entero entre 0 y 9" }` |
  | 400 | `anio` inválido en `entries[i]` | `{ "error": "entries[i].anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `anio` de `entries[i]` distinto del body | `{ "error": "entries[i].anio debe coincidir con anio del body (<anio>)" }` |
  | 400 | `mes` inválido en `entries[i]` | `{ "error": "entries[i].mes debe ser un entero entre 1 y 12" }` |
  | 400 | `fecha_vencimiento` inválida en `entries[i]` | `{ "error": "entries[i].fecha_vencimiento debe tener formato YYYY-MM-DD" }` |
  | 500 | Error de DB (upsert, select o delete) | `{ "error": "Error interno del servidor" }` |

  > **Idempotencia:** correr el mismo `PUT` dos veces deja el mismo estado, **incluido** `terminacion_cuit = null`. El índice único `(estudio_id, obligacion, terminacion_cuit, anio, mes)` es `NULLS NOT DISTINCT` (PG15+), así el `null` ("todos") también colisiona y se actualiza en vez de duplicarse.
  > `i` en los mensajes es el índice 0-based del entry que falló; se valida en orden y se corta en el primero inválido.

#### `DELETE /api/vencimientos/:id`
- **Rol:** contador.
- **Borra un vencimiento por id**, solo si pertenece al estudio del token.
- **Response 204:** sin body.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 404 | El vencimiento no existe o es de otro estudio | `{ "error": "Vencimiento no encontrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

---

### 3.7 Movimientos (libro IVA) — `/api/movimientos`

Auth aplicada **por ruta**. Los endpoints de **contador** (importar, CRUD manual, y los 3 GET de lectura por `cliente_id`) usan `requireRole('contador')`; los de **cliente** (lectura del propio libro, sección **3.7.b**) usan `requireRole('cliente')`.
**Multi-tenant:** todas filtran/escriben por `estudio_id` del token. Un movimiento o cliente de otro estudio responde **404** (en los de contador).

Dos formas de poblar el libro: **importar** un `.xlsx` (`origen = 'importado'`) o **carga manual** (`origen = 'manual'`). Los importados **no** se editan/borran por API: se gestionan re-subiendo el libro (ver más abajo).

**Lectura del contador (3 GET):** listado del libro de un cliente por período, resumen recalculado del período, y serie de tendencia multi-mes. Toman `cliente_id` por query y validan que el cliente exista, sea `role = cliente` y del estudio del token (si no → 404). El `periodo` se arma como `YYYY-MM-01` a partir de `anio`/`mes`. El **cliente** tiene los mismos 3 GET sobre **su propio** libro en `/api/movimientos/mis-movimientos` (sección 3.7.b): resuelve `cliente_id` desde el token, no de la query.

> **Montos:** Supabase puede serializar `NUMERIC` como **string**. El resumen y la tendencia hacen aritmética, así que coaccionan cada monto con `Number(...)` antes de sumar (`null`/`undefined`/no finito → `0`).

#### `GET /api/movimientos`
- **Rol:** contador.
- **Lista los movimientos** del libro de un cliente para un período (`origen` indistinto). Array plano.
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `cliente_id` | string (uuid) | sí | formato uuid; cliente del estudio (si no → 404) |
  | `anio` | string→number | sí | entero entre **2024 y 2100** |
  | `mes` | string→number | sí | entero entre **1 y 12** |
  | `tipo` | string | no | si viene, `compra` o `venta`; otro valor → 400 |

- **Orden:** `fecha` asc, luego `created_at` asc.
- **Response 200:** array de `Movimiento` (`MOVIMIENTO_FIELDS`); `[]` si no hay.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `cliente_id` ausente o no uuid | `{ "error": "cliente_id debe ser un uuid válido" }` |
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | `tipo` viene y ≠ `compra`/`venta` | `{ "error": "tipo debe ser 'compra' o 'venta'" }` |
  | 404 | Cliente inexistente / de otro estudio / no es cliente | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `GET /api/movimientos/resumen`
- **Rol:** contador.
- **Resumen recalculado** del período (no se persiste nada). Trae todos los movimientos del estudio+cliente+período y recalcula los headline numbers + el desglose por alícuota.
- **Query params:** `cliente_id` (uuid, req), `anio` (req, 2024–2100), `mes` (req, 1–12). Mismas validaciones que el listado (sin `tipo`).
- **Response 200:** objeto `ResumenLibroIVA`:
  ```json
  {
    "periodo": { "anio": 2026, "mes": 4 },
    "ventas":  { "cantidad": 1, "total": 121, "neto": 100, "iva": 21, "op_exentas": 0, "ret_perc": 0 },
    "compras": { "cantidad": 1, "total": 55.25, "neto": 50, "iva": 5.25, "op_exentas": 0, "ret_perc": 0 },
    "iva":     { "debito": 21, "credito": 5.25, "saldo": 15.75 },
    "por_alicuota": [
      { "tipo": "venta", "alicuota": 21, "neto": 100, "iva": 21, "cantidad": 1 },
      { "tipo": "compra", "alicuota": 10.5, "neto": 50, "iva": 5.25, "cantidad": 1 }
    ]
  }
  ```
  > **`ventas`/`compras`** (bloque por `tipo`): `cantidad` = nº de movimientos; `total`/`neto`/`iva`/`op_exentas` = sumas; `ret_perc` = suma de `retenciones_percepciones`. Todo coaccionado (`null` → 0) y redondeado a 2 decimales.
  > **`iva`:** `debito` = `ventas.iva`, `credito` = `compras.iva`, `saldo` = `debito − credito`.
  > **`por_alicuota`:** un bucket por `(tipo, alicuota)`. La alícuota se **infiere** como `iva/neto*100` redondeado a la tasa estándar AR más cercana dentro de **±0.5** puntos (`21, 10.5, 27, 5, 2.5, 0`); si ninguna matchea → `"otras"`. Solo entran movimientos con `neto > 0` e `iva` no `null` (el resto **igual** cuenta en los totales de bloque, pero no acá). Suma `neto`/`iva` y cuenta por bucket.

- **Responses de error:** iguales al listado (sin la fila de `tipo`).

#### `GET /api/movimientos/tendencia`
- **Rol:** contador.
- **Serie multi-mes** para el gráfico de tendencia: los últimos `meses` meses terminando en `(anio, mes)` **inclusive**, en una sola query.
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `cliente_id` | string (uuid) | sí | formato uuid; cliente del estudio (si no → 404) |
  | `anio` | string→number | sí | entero entre **2024 y 2100** |
  | `mes` | string→number | sí | entero entre **1 y 12** |
  | `meses` | string→number | no | entero entre **1 y 36**; **default 12** |

  > Ventana de los últimos `meses` meses terminando en `(anio, mes)`. Ej: `anio=2026, mes=4, meses=12` → `2025-05` … `2026-04`. Los meses **sin movimientos** se incluyen igual con todo en `0` y `cantidad 0` (eje continuo). Si la ventana arranca antes de 2024, esos meses van en `0` (sin clamp).

- **Orden:** cronológico ascendente (más viejo → más nuevo). El array tiene **exactamente `meses`** elementos.
- **Response 200:** array de `TendenciaMes`:
  ```json
  [
    {
      "periodo": { "anio": 2026, "mes": 4 },
      "cantidad": 2,
      "ventas_total": 121,
      "compras_total": 55.25,
      "iva_debito": 21,
      "iva_credito": 5.25,
      "iva_saldo": 15.75
    }
  ]
  ```
  > Por mes: `cantidad` = nº de movimientos; `ventas_total`/`compras_total` = suma `total` de `venta`/`compra`; `iva_debito`/`iva_credito` = suma `iva` de `venta`/`compra`; `iva_saldo` = `debito − credito`. Coacción de montos + redondeo 2 decimales (mismos helpers que el resumen).

- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `cliente_id` ausente o no uuid | `{ "error": "cliente_id debe ser un uuid válido" }` |
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | `meses` viene y no es entero o fuera de 1–36 | `{ "error": "meses debe ser un entero entre 1 y 36" }` |
  | 404 | Cliente inexistente / de otro estudio / no es cliente | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `POST /api/movimientos/importar`
- **Rol:** contador.
- **Importa un libro IVA (`.xlsx`) de un cliente** para un período, con **reemplazo atómico** de los importados previos de ese libro.
- **Content-Type:** `multipart/form-data` (**no** JSON). Procesado con `multer` (`memoryStorage`, límite **5 MB**, un solo archivo en el campo `archivo`). `fileFilter` acepta solo `.xlsx` (por mimetype `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` **o** extensión `.xlsx`); si no pasa el filtro, `req.file` queda `undefined` → 400 "archivo requerido".
- **Campos del form-data:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `archivo` | file (`.xlsx`) | sí | ver `fileFilter` arriba; máx 5 MB |
  | `cliente_id` | string (uuid) | sí | formato uuid; el cliente debe existir, ser `role = cliente` y del `estudio_id` del token |
  | `anio` | string→number | sí | entero entre **2024 y 2100** (se coacciona con `Number`) |
  | `mes` | string→number | sí | entero entre **1 y 12** |

  > El `periodo` se arma como `YYYY-MM-01` a partir de `anio`/`mes`. El parser lee el archivo y valida que el **CUIT** y el **período** del `.xlsx` coincidan con el cliente y el `anio`/`mes` enviados, y que los **totales declarados cuadren** con la suma de los registros (tolerancia ~1 peso). `origen` se fuerza a `importado`; `estudio_id`/`creado_por` salen del token.

- **Response 200** (no 201):
  ```json
  {
    "tipo": "compra",
    "periodo": { "anio": 2026, "mes": 4 },
    "importados": 5,
    "reemplazados": 2,
    "validacion": { "ok": true }
  }
  ```
  > `importados` = filas insertadas; `reemplazados` = importados previos borrados en el mismo libro/período. El reemplazo (delete + insert) es atómico vía `supabase.rpc('reemplazar_movimientos_importados', ...)`.

- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `cliente_id` ausente o no uuid | `{ "error": "cliente_id debe ser un uuid válido" }` |
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | Falta el archivo | `{ "error": "El archivo .xlsx es requerido en el campo \"archivo\"" }` |
  | 404 | Cliente inexistente / de otro estudio / no es cliente | `{ "error": "Cliente no encontrado" }` |
  | 400 | No se pudo leer el `.xlsx` | `{ "error": "No se pudo leer el archivo .xlsx" }` |
  | 400 | El archivo no parece un libro IVA válido | `{ "error": "<mensaje del parser>" }` (p. ej. `"El archivo no parece un libro IVA válido"`) |
  | 400 | El cliente no tiene CUIT cargado | `{ "error": "El cliente no tiene CUIT cargado" }` |
  | 400 | El CUIT del archivo ≠ el del cliente | `{ "error": "El CUIT del archivo no coincide con el del cliente" }` |
  | 400 | El período del archivo ≠ `anio`/`mes` | `{ "error": "El período del archivo no coincide con el mes/año seleccionados" }` |
  | 400 | Los totales no cuadran | `{ "error": "Los totales del archivo no cuadran con lo declarado", "detalle": { /* validación */ } }` |
  | 500 | La rpc devuelve error / sin data | `{ "error": "Error interno del servidor" }` |

  > Un archivo **>5 MB** dispara `MulterError LIMIT_FILE_SIZE` antes de llegar al controller; el error handler global lo responde como `400 { "error": "El archivo supera el tamaño máximo permitido (5MB)" }` (ver Notas transversales de la sección 3).

#### `POST /api/movimientos`
- **Rol:** contador.
- **Crea un movimiento manual** (`origen = 'manual'`) en el libro de un cliente del estudio. Content-Type JSON.
- **Request body:**

  | Campo | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `cliente_id` | string (uuid) | sí | formato uuid; el cliente debe existir, ser `role = cliente` y del `estudio_id` del token |
  | `tipo` | string | sí | `compra` o `venta` |
  | `anio` | number | sí | entero entre **2024 y 2100** |
  | `mes` | number | sí | entero entre **1 y 12** |
  | `fecha` | string | sí | formato `YYYY-MM-DD` y fecha parseable |
  | `total` | number | sí | número **finito**; **puede ser negativo** (notas de crédito). No se valida positividad. |
  | `tipo_comprobante`, `letra`, `numero`, `contraparte`, `cuit_contraparte` | string | no | si vienen, string |
  | `neto`, `concepto_no_gravado`, `iva`, `acrecentamiento`, `retenciones_percepciones`, `op_exentas` | number\|null | no | si vienen, número finito o `null` (sin validar positividad) |

  > `anio`/`mes` se combinan en `periodo = YYYY-MM-01` (período del libro, **distinto** de `fecha`, que es la del comprobante). `origen` se fuerza a `manual`; `estudio_id` y `creado_por` salen del token. `cliente_id` **no** se acepta en el PATCH (no se mueve de cliente).
  > `concepto_no_gravado` y `acrecentamiento` son `NOT NULL` en la DB: si **no** se envían, quedan en el **default `0`** del schema (no se mandan en el insert).

- **Response 201:** objeto `Movimiento` completo (`MOVIMIENTO_FIELDS`).
- **Responses de error (en orden de evaluación, todas antes de tocar la DB salvo el 404/500):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `cliente_id` ausente o no uuid | `{ "error": "cliente_id debe ser un uuid válido" }` |
  | 400 | `tipo` ausente o ≠ `compra`/`venta` | `{ "error": "tipo debe ser 'compra' o 'venta'" }` |
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | `fecha` ausente o con formato inválido | `{ "error": "fecha debe tener formato YYYY-MM-DD" }` |
  | 400 | `total` ausente o no finito | `{ "error": "total es requerido y debe ser un número finito" }` |
  | 400 | Un monto opcional viene y no es finito ni `null` | `{ "error": "<campo> debe ser un número finito o null" }` |
  | 400 | Un string opcional viene y no es string | `{ "error": "<campo> debe ser un string" }` |
  | 404 | Cliente inexistente / de otro estudio / no es cliente | `{ "error": "Cliente no encontrado" }` |
  | 500 | Error de inserción | `{ "error": "Error interno del servidor" }` |

#### `PATCH /api/movimientos/:id`
- **Rol:** contador.
- **Edita un movimiento MANUAL del estudio.** Solo `origen = 'manual'`: un importado responde **400** (se gestionan re-subiendo el libro).
- **Request body:** (todos opcionales, al menos uno requerido). **No** acepta `cliente_id` (se ignora). Mismas validaciones que el create para cada campo que venga.

  | Campo | Tipo | Validación |
  |---|---|---|
  | `tipo` | string | si viene, `compra` o `venta` |
  | `anio` + `mes` | number | **si viene uno, se exigen ambos** para recomponer `periodo` (`YYYY-MM-01`). Mismos rangos que el create. |
  | `fecha` | string | si viene, `YYYY-MM-DD` válida |
  | `total` | number | si viene, número finito (puede ser negativo) |
  | `tipo_comprobante`, `letra`, `numero`, `contraparte`, `cuit_contraparte` | string | si vienen, string |
  | `neto`, `concepto_no_gravado`, `iva`, `acrecentamiento`, `retenciones_percepciones`, `op_exentas` | number\|null | si vienen, número finito o `null` |

- **Response 200:** objeto `Movimiento` actualizado (`MOVIMIENTO_FIELDS`).
- **Responses de error (en orden de evaluación):**

  | Status | Caso | Body |
  |---|---|---|
  | 400 | `tipo` ≠ `compra`/`venta` | `{ "error": "tipo debe ser 'compra' o 'venta'" }` |
  | 400 | `anio`/`mes` inválidos o incompletos | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` / `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | `fecha` con formato inválido | `{ "error": "fecha debe tener formato YYYY-MM-DD" }` |
  | 400 | `total` no finito | `{ "error": "total debe ser un número finito" }` |
  | 400 | Monto/string opcional inválido | `{ "error": "<campo> debe ser un número finito o null" }` / `{ "error": "<campo> debe ser un string" }` |
  | 400 | No se envió ningún campo | `{ "error": "No se enviaron campos para actualizar" }` |
  | 404 | Movimiento no existe en el estudio | `{ "error": "Movimiento no encontrado" }` |
  | 400 | El movimiento es `origen = 'importado'` | `{ "error": "No se puede editar un movimiento importado; los importados se gestionan re-subiendo el libro" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `DELETE /api/movimientos/:id`
- **Rol:** contador.
- **Borra un movimiento MANUAL del estudio.** Mismas reglas que el PATCH: solo `origen = 'manual'`; un importado responde **400**.
- **Response 204:** sin body.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 404 | Movimiento no existe / es de otro estudio | `{ "error": "Movimiento no encontrado" }` |
  | 400 | El movimiento es `origen = 'importado'` | `{ "error": "No se puede eliminar un movimiento importado; los importados se gestionan re-subiendo el libro" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

---

### 3.7.b Lectura del propio libro — rol **cliente** (`/api/movimientos/mis-movimientos`)

Auth **por ruta** + rol **cliente** (`authenticate, requireRole('cliente')`). El cliente ve **su propio** libro (manual + importado), **solo lectura**: no hay alta/edición/borrado.

**Multi-tenant + identidad:** `estudio_id` y `cliente_id` salen **del token** (`req.user.estudio_id`, `req.user.id`). **`cliente_id` por query se IGNORA** (si llega, no se usa: siempre se filtra por el del token). No hay verificación previa del cliente (es el del token) → no devuelven **404 "Cliente no encontrado"**.

Mismos cálculos y shapes que los GET de contador (sección 3.7): reusan los mismos helpers (`calcularResumen`, `tendenciaDelMes`, etc.). `periodo` se arma como `YYYY-MM-01` a partir de `anio`/`mes`. Aplica la misma nota de **montos string** (coacción `Number(...)`, `null`/no finito → `0`).

#### `GET /api/movimientos/mis-movimientos`
- **Rol:** cliente.
- **Lista los movimientos** del propio libro para un período (`origen` indistinto). Array plano.
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `anio` | string→number | sí | entero entre **2024 y 2100** |
  | `mes` | string→number | sí | entero entre **1 y 12** |
  | `tipo` | string | no | si viene, `compra` o `venta`; otro valor → 400 |

  > `cliente_id` **no** es un parámetro: si se envía, se ignora.

- **Orden:** `fecha` asc, luego `created_at` asc.
- **Response 200:** array de `Movimiento` (`MOVIMIENTO_FIELDS`); `[]` si no hay.
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 401 | Sin token / token inválido | `{ "error": "Token requerido" }` / `{ "error": "Token inválido o expirado" }` |
  | 403 | Rol `contador` o `admin` | `{ "error": "Sin permiso para esta acción" }` |
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | `tipo` viene y ≠ `compra`/`venta` | `{ "error": "tipo debe ser 'compra' o 'venta'" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

#### `GET /api/movimientos/mis-movimientos/resumen`
- **Rol:** cliente.
- **Resumen recalculado** del propio libro para el período (no se persiste). Mismo cálculo y shape que `GET /api/movimientos/resumen`.
- **Query params:** `anio` (req, 2024–2100), `mes` (req, 1–12). Sin `cliente_id` (se ignora), sin `tipo`.
- **Response 200:** objeto `ResumenLibroIVA` (ver sección 3.7 para el detalle de `ventas`/`compras`/`iva`/`por_alicuota`).
- **Responses de error:** `401` sin token, `403` rol `contador`/`admin`, `400` `anio`/`mes` fuera de rango, `500` error de DB (mismos bodies que arriba).

#### `GET /api/movimientos/mis-movimientos/tendencia`
- **Rol:** cliente.
- **Serie multi-mes** del propio libro: últimos `meses` meses terminando en `(anio, mes)` **inclusive**, en una sola query. Misma ventana/cálculo que `GET /api/movimientos/tendencia`.
- **Query params:**

  | Param | Tipo | Obligatorio | Validación |
  |---|---|---|---|
  | `anio` | string→number | sí | entero entre **2024 y 2100** |
  | `mes` | string→number | sí | entero entre **1 y 12** |
  | `meses` | string→number | no | entero entre **1 y 36**; **default 12** |

  > `cliente_id` se ignora. Meses sin movimientos van en `0` con `cantidad 0` (eje continuo).

- **Orden:** cronológico ascendente; el array tiene **exactamente `meses`** elementos.
- **Response 200:** array de `TendenciaMes` (ver sección 3.7).
- **Responses de error:**

  | Status | Caso | Body |
  |---|---|---|
  | 401 | Sin token / token inválido | `{ "error": "Token requerido" }` / `{ "error": "Token inválido o expirado" }` |
  | 403 | Rol `contador` o `admin` | `{ "error": "Sin permiso para esta acción" }` |
  | 400 | `anio` no entero o fuera de 2024–2100 | `{ "error": "anio debe ser un entero entre 2024 y 2100" }` |
  | 400 | `mes` no entero o fuera de 1–12 | `{ "error": "mes debe ser un entero entre 1 y 12" }` |
  | 400 | `meses` viene y no es entero o fuera de 1–36 | `{ "error": "meses debe ser un entero entre 1 y 36" }` |
  | 500 | Error de DB | `{ "error": "Error interno del servidor" }` |

---

## 4. Reglas de negocio

### Aislamiento multi-tenant

- **No se usa RLS.** El cliente de Supabase usa la **Service Role Key**, que bypassa Row Level Security. El aislamiento es 100% responsabilidad del backend.
- Mecanismo: cada query de un **contador** o **cliente** filtra por `estudio_id` tomado del JWT (`req.user.estudio_id`). Ejemplos: `listarClientes`, `crearImpuesto`, `misImpuestos`, etc. siempre agregan `.eq('estudio_id', ...)`.
- El **admin** no tiene estudio (`estudio_id = null`) y opera sobre contadores de forma global; al crear un contador, le asigna el `estudio_id` recibido en el body.
- Consecuencia para el contrato: un recurso de otro estudio responde **404** (no 403), porque el filtro `estudio_id` hace que la fila "no exista" para esa query.

### El cron de vencimientos

- Definido en `src/jobs/vencimientosCron.ts`. **Mecanismo configurable con `CRON_SCHEDULER`** (M5 — elegir UNO, configurar ambos duplicaría el procesamiento):
  - `internal` (default): `src/index.ts` llama `initCronJobs()` al arrancar y `node-cron` agenda los jobs in-process.
  - `external`: el server **no** agenda nada; un scheduler externo debe disparar `POST /api/internal/run-cron` (con `x-cron-secret`). Usar en serverless o con múltiples instancias.
  - Cualquier otro valor aborta el arranque con error.
- **Dos jobs, ambos a las `08:00` hora `America/Argentina/Buenos_Aires`** (cron expr `0 8 * * *`):
  1. **`procesarVencidos`** — busca impuestos `estado = 'pendiente'` con `fecha_vencimiento < hoy (ART)`. Para cada uno: si ya existe notificación `tipo = 'vencido'` lo saltea; si no, **cambia `estado → vencido`**, envía email `sendVencido` **al cliente** (`impuesto.cliente.email`) y registra notificación `vencido`.
  2. **`procesarRecordatorios`** — busca impuestos `estado = 'pendiente'` con `fecha_vencimiento = hoy + 3 días (ART)`. Para cada uno: si ya existe notificación `recordatorio_3dias` lo saltea; si no, envía `sendRecordatorio` al cliente y registra notificación `recordatorio_3dias`.
- **Cálculo de fechas:** "hoy" se obtiene con `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })` → `YYYY-MM-DD` en horario argentino.
- **Anti-duplicado:** tabla `notificaciones` deduplicada por `(impuesto_id, tipo)`.
- **Disparo manual / externo:** `POST /api/internal/run-cron` con header `x-cron-secret` (ver 3.5). El endpoint existe siempre (también con `CRON_SCHEDULER=internal`, para disparos manuales); el modo `external` es el único soportado para schedulear desde afuera.
- **(verificar) — bug conocido en `procesarVencidos`:** el cambio de estado a `vencido` ocurre **antes** de enviar el email. Si el email falla, la notificación `vencido` **no** se inserta, pero el estado ya quedó en `vencido`; como la query del cron solo busca `estado = 'pendiente'`, ese impuesto **nunca se reintenta** y el email de vencimiento se pierde definitivamente.

### Feature flags

| Flag (env) | Default | Efecto |
|---|---|---|
| `EMAILS_ENABLED` | `false` | Solo si vale exactamente `'true'` se envían emails reales vía Resend. Con cualquier otro valor, las funciones de email loguean `SKIP` y retornan sin enviar (toda la lógica de notificaciones/negocio igual corre). |

- Emails (`src/services/emailService.ts`): `sendNuevoImpuesto`, `sendRecordatorio`, `sendVencido`. Los tres se envían **al email del cliente**. HTML escapado (`escapeHtml`), montos en formato `ARS` (`Intl` es-AR), fechas `DD/MM/YYYY`. Remitente configurable con `EMAIL_FROM` (default `Sistema Contable <notificaciones@tudominio.com>`).

### Rate limiting

- Solo el login (`loginLimiter`): **10 requests / 15 minutos**, identificado por IP. Excedido ⇒ `429 { "error": "Demasiados intentos, intente de nuevo en 15 minutos" }`. Headers estándar `RateLimit-*` activados (`standardHeaders: true`, `legacyHeaders: false`).
- Ningún otro endpoint tiene rate limit.

### CORS

- Allowlist vía env `ALLOWED_ORIGINS` (CSV, se trimean los valores). Vacío por default ⇒ ningún origin de navegador permitido.
- Requests **sin** header `Origin` (ej. server-to-server, curl) **se permiten** (`!origin → callback(null, true)`).
- Origin no permitido ⇒ el middleware `cors` pasa un `Error` ⇒ el error handler global (`src/middleware/errorHandler.ts`) responde `403 { "error": "CORS: origen no permitido" }`.
- `credentials: true`.

### Variables de entorno

| Variable | Requerida | Uso |
|---|---|---|
| `JWT_SECRET` | sí | Firma/verificación de JWT |
| `SUPABASE_URL` | sí | Conexión Supabase |
| `SUPABASE_SERVICE_KEY` | sí | Service Role Key (bypassa RLS — secreto) |
| `RESEND_API_KEY` | sí | Cliente Resend |
| `CRON_SECRET` | no* | Autoriza `/api/internal/run-cron`. Sin esto el endpoint responde 503. |
| `CRON_SCHEDULER` | no | `internal` (default, node-cron in-process) o `external` (sin scheduler interno; disparar vía `/api/internal/run-cron`). Otro valor aborta el arranque. |
| `PORT` | no | Puerto HTTP (default 3000) |
| `ALLOWED_ORIGINS` | no | CSV de orígenes CORS |
| `EMAIL_FROM` | no | Remitente de emails |
| `EMAILS_ENABLED` | no | Flag de envío real (default off) |

- En el arranque (`src/index.ts`), si falta alguna de las 4 requeridas el proceso **termina con error** — salvo `NODE_ENV=test`, donde se omite la validación.

### Comportamiento no obvio (resumen)

- `trust proxy = 1` seteado en `createApp()` — para que `req.ip` y el rate-limit funcionen detrás de un proxy/CDN.
- Acceder a un recurso de otro estudio devuelve **404**, no 403.
- Desactivar un usuario o su estudio **sí** corta sesiones vivas: `authenticate` consulta `activo` en DB en cada request (401 `Cuenta desactivada` / `Estudio desactivado`). Cambiar la contraseña, en cambio, **no** invalida tokens vigentes.
- `monto` y `telefono` no validan longitud/formato en update → un valor que viole el límite de la columna devuelve **500** (error de DB), no 400. `cuit` **sí** se valida (formato + dígito verificador) tanto en create como en update de clientes.
- El objeto `user` del login devuelve el `User` **completo** (mismo shape que los demás endpoints, sin `password_hash`); incluye `condicion_fiscal`/`categoria`.
- El orden de evaluación de errores (400 "sin campos" vs 404 "no existe") difiere entre `PATCH contadores/:id` y `PATCH clientes/:id`.
- Los `borrador` los ve **solo el contador**: aparecen en `GET /api/impuestos` (sin filtro) pero `GET /api/impuestos?estado=borrador` devuelve **400** y `/mis-impuestos` los excluye. Nunca vencen (el cron solo mira `pendiente`).
- `POST /api/impuestos/generar` es **idempotente** y **no** envía emails; saltea clientes sin `condicion_fiscal` o con CUIT inválido reportándolos en la respuesta (no falla).
- `PATCH /:id/estado` sobre un `borrador` se rechaza con **400 controlado** (guard antes de la DB; mensaje "Un borrador no se puede cambiar de estado; cargá el monto para pasarlo a pendiente"). Para pagarlo hay que completarle el monto antes vía `PATCH /:id` (lo pasa a `pendiente`).

---

## 5. Lo que NO está implementado

Funcionalidades ausentes, deshabilitadas o solo parcialmente presentes en el código:

- **Estudios:** la tabla `estudios` existe y se referencia, pero **no hay endpoints** para crear, listar, editar ni desactivar estudios. Deben gestionarse directamente en la base. El frontend no puede dar de alta un estudio vía API.
- **Alta de admin:** no hay endpoint de signup ni de creación de admin. El admin debe sembrarse manualmente en la DB (recordar el constraint `chk_estudio_por_role`: admin con `estudio_id = NULL`).
- **Logout / revocación de tokens:** no hay logout server-side ni blacklist, pero `authenticate` verifica `activo` (usuario y estudio) en DB por request, así que **desactivar sí revoca** en la práctica. Cambiar la contraseña **no** invalida JWT vigentes (siguen válidos hasta expirar: 8h o 10d).
- **Refresh token:** no hay. Cuando el token expira, el usuario debe volver a loguearse.
- **Self-service del usuario logueado:** un cliente no puede editar su propio perfil ni cambiar su propia contraseña (solo el contador cambia la contraseña del cliente). No hay cambio de contraseña para contadores ni admins vía API.
- **DELETE:** solo hay borrado físico en **vencimientos** (`DELETE /api/vencimientos/:id`) y en **movimientos manuales** (`DELETE /api/movimientos/:id`, nunca importados). Para **users** la baja es lógica (`activo = false`, solo contadores y clientes); **impuestos** no tienen baja de ningún tipo.
- **Notificaciones expuestas:** la tabla `notificaciones` no tiene endpoints de lectura; es solo interna para deduplicar.
- **Emails en producción:** `EMAILS_ENABLED` está en `false` por default; mientras no se setee a `'true'`, no se envía ningún email real.
- **Headers de seguridad:** no hay Helmet ni HSTS/CSP/X-Frame-Options configurados en el código (`DOCUMENTATION.md` lo marca como pendiente).
- **`runVencimientosCron()`** (en `vencimientosCron.ts`) es un wrapper exportado que solo llama a `procesarVencidos`; no lo usa ni el scheduler ni el endpoint interno (ambos llaman a `procesarVencidos`/`procesarRecordatorios` directamente). Código efectivamente sin uso. **(verificar)** si el frontend/otros consumidores lo referencian.
