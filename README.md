# Recetario API

API REST serverless para la app de recetas en Kotlin.

**Stack:** TypeScript (Node.js 22) · AWS SAM · API Gateway (HTTP API) · Lambda (arm64) · DynamoDB (usuarios y recetas) · Cloudinary (fotos)

```
App Kotlin ──► API Gateway ──► Lambda (valida el token) ──► DynamoDB
     │                                         ├─ tabla usuarios  (correo, nombre, hash de contraseña)
     │                                         └─ tabla recetas   (por usuario + índice por recetaId)
     └──(foto, con firma de la API)──► Cloudinary
```

Las recetas son **públicas**: cualquiera puede explorarlas sin cuenta. Solo quien tiene cuenta crea recetas, y
solo el creador puede editarlas o eliminarlas.

## Requisitos

- Node.js 22+
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configurado (`aws configure`) o las credenciales del Learner Lab (ver abajo)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

## Desplegar desde cero

Elige la plantilla según tu cuenta de AWS:

| Cuenta | Plantilla |
|---|---|
| Cuenta normal de AWS | `template.yaml` (la que SAM usa por defecto) |
| AWS Academy Learner Lab | `template-learner-lab.yaml` (las Lambdas usan el rol `LabRole`, porque el lab no deja crear roles de IAM) |

### 1. Preparar credenciales

- **Cuenta normal:** `aws configure` y comprueba con `aws sts get-caller-identity`.
- **Learner Lab:** **Start Lab** → espera el círculo verde → **AWS Details** → **AWS CLI: Show**. Pega las 3 líneas
  (`aws_access_key_id`, `aws_secret_access_key`, `aws_session_token`) en `~/.aws/credentials`
  (Windows: `C:\Users\<usuario>\.aws\credentials`) bajo `[default]`, y en `~/.aws/config` pon `region = us-east-1`.
  Las credenciales caducan cuando termina la sesión del lab: hay que volver a copiarlas cada vez que lo inicies.

### 2. Generar la clave para firmar tokens (`JwtSecret`)

La API firma con esta clave los tokens de sesión. Debe tener mínimo 32 caracteres y no debe compartirse ni subirse a Git.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copia el resultado y guárdalo: lo necesitarás en el paso 3 y en cada redespliegue.

### 2b. Cuenta de Cloudinary

Las fotos se alojan en Cloudinary (el plan gratuito basta: 10 MB por imagen). En el panel de tu cuenta hay tres datos:
**cloud name**, **API key** y **API secret**. Solo el secreto es confidencial: nunca va en la app, en Git ni en un chat.
Se pasan como parámetros de SAM (`CloudinaryCloudName`, `CloudinaryApiKey`, `CloudinaryApiSecret`) y llegan a las Lambdas
como variables de entorno. Si el secreto se expone, se regenera en Cloudinary y se vuelve a desplegar.

### 3. Compilar y desplegar

```bash
npm install
npm run typecheck        # opcional: revisa tipos
```

Cuenta normal:

```bash
sam build
sam deploy --guided
```

Learner Lab:

```bash
sam build -t template-learner-lab.yaml
sam deploy --guided
```

Respuestas para `sam deploy --guided`:

| Pregunta | Respuesta |
|---|---|
| Stack Name | `recetario-api` (o el que quieras) |
| AWS Region | tu región (en el Learner Lab: `us-east-1`) |
| Parameter Stage | Enter (`dev`) |
| Parameter CloudinaryCloudName | el *cloud name* de tu cuenta |
| Parameter CloudinaryApiKey | la *API key* de tu cuenta |
| Parameter CloudinaryApiSecret | el *API secret* (no se muestra al escribir) |
| Parameter JwtSecret | pega la clave del paso 2 (no se muestra al escribir) |
| Confirm changes before deploy | `N` (o `y` si quieres revisar el cambio) |
| Allow SAM CLI IAM role creation | Enter (`Y`) |
| Disable rollback | Enter (`N`) |
| `<Función> has no authentication. Is this okay?` | **`y`** (aparece una vez por función). Es correcto: la API valida el token dentro de cada Lambda, y `/register` y `/login` deben ser públicas |
| Save arguments to configuration file | Enter (`Y`) |

Tarda unos minutos. Se crean la API, las 8 Lambdas y las tablas de **usuarios** y **recetas** (DynamoDB, la de recetas con un índice por `recetaId`).

### 4. Obtener la URL

Al terminar, SAM imprime los **Outputs**: `ApiUrl` y `Region`. Para volver a verlos:

```bash
aws cloudformation describe-stacks --stack-name recetario-api --query "Stacks[0].Outputs"
```

Pega la `ApiUrl` (termina en `/`) en la app Android, en `app/build.gradle.kts`, dentro de `API_BASE_URL`.

### 5. Probar que funciona

```bash
API=<ApiUrl sin la barra final>
curl -X POST "$API/register" -H "Content-Type: application/json" \
  -d '{"nombre":"Ana","correo":"ana@correo.com","password":"Passw0rd123"}'
```

Debe responder `201` con un `token` y los datos del usuario. Si responde `500`, revisa los logs con
`sam logs --stack-name recetario-api --tail`.

### Redesplegar después de cambios

Los secretos no se guardan en `samconfig.toml`, así que se pasan cada vez:

```bash
sam build                # o: sam build -t template-learner-lab.yaml
sam deploy --parameter-overrides JwtSecret="<tu clave>" CloudinaryCloudName="<cuenta>" \
  CloudinaryApiKey="<api key>" CloudinaryApiSecret="<api secret>"
```

Usa siempre la misma clave: si cambia, los tokens ya emitidos dejan de ser válidos y los usuarios tendrán que iniciar sesión otra vez.

### Si ya tenías una versión anterior desplegada (con Cognito)

Esta versión no es compatible con ella. Elimínala primero (`sam delete --stack-name <stack-anterior>`) o usa otro
nombre de stack. Los usuarios y recetas anteriores no se conservan.

## Endpoints

`/register`, `/login` y la lectura de recetas (`GET /recetas`, `GET /recetas/{id}`) son **públicos**. El resto exige el
header `Authorization: Bearer <token>` con el `token` que devuelven `/register` y `/login`. En las rutas públicas el token
es opcional: si viene y es válido, la respuesta indica con `esPropia` si la receta es del usuario; si falta o venció, se
trata como visitante.

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| POST | `/register` | Público | Guarda el usuario en la base de datos y devuelve la sesión. Body: `{ nombre, correo, password }` |
| POST | `/login` | Público | Inicia sesión. Body: `{ correo, password }` |
| GET | `/recetas` | Público | Catálogo con las recetas de todos. Filtros opcionales: `?categoria=postre&q=pastel` |
| GET | `/recetas?mias=true` | Token | Solo las recetas del usuario. Admite además `&favorita=true` |
| GET | `/recetas/{id}` | Público | Detalle de una receta |
| POST | `/recetas` | Token | Crea una receta (puedes mandar tu propio `recetaId` UUID; debe ser único en toda la tabla). Es pública desde que se guarda |
| PUT | `/recetas/{id}` | Creador | Edita una receta (reemplaza los campos editables) |
| DELETE | `/recetas/{id}` | Creador | Elimina la receta y su foto |
| POST | `/recetas/{id}/imagen-firma` | Creador | Devuelve la firma para subir la foto de esa receta a Cloudinary |

### Respuesta de `/register` y `/login`

```json
{ "token": "<JWT firmado por la API>", "usuario": { "id": "…", "nombre": "Ana", "correo": "ana@correo.com" } }
```

La contraseña debe tener mínimo 8 caracteres. Se guarda cifrada (scrypt con sal), nunca en texto plano.
Errores: `400` datos inválidos · `401` credenciales incorrectas · `409` el correo ya existe.
El token dura 24 horas; pasado ese tiempo la API responde `401` y la app debe volver a iniciar sesión.

### Cuerpo de POST / PUT `/recetas`

```json
{
  "titulo": "Pastel de chocolate",
  "descripcion": "Húmedo y fácil",
  "categoria": "postre",
  "tiempoMinutos": 60,
  "porciones": 8,
  "ingredientes": [
    { "nombre": "Harina", "cantidad": "2", "unidad": "tazas" },
    { "nombre": "Cacao", "cantidad": "1/2", "unidad": "taza" }
  ],
  "pasos": ["Precalienta el horno a 180 °C", "Mezcla los ingredientes secos"],
  "favorita": false
}
```

### Respuesta de una receta

Además de los campos del cuerpo, trae `recetaId`, `creadaEn`, `actualizadaEn` y:

- `esPropia`: `true` si la receta es del usuario que hace la petición (siempre `false` para visitantes). La API no expone el id del autor.
- `imagenUrl` e `imagenPublicId`: la foto en Cloudinary, o `null` si no tiene.

### Fotos (Cloudinary)

La app sube la foto directo a Cloudinary; la API solo firma la subida y guarda la URL. El secreto de Cloudinary nunca sale de la API.

1. La receta debe existir. Si es nueva, se guarda primero sin foto (`POST /recetas`).
2. `POST /recetas/{id}/imagen-firma` (con token del creador) devuelve:
   `{ uploadUrl, cloudName, apiKey, timestamp, signature, publicId, allowedFormats, overwrite, invalidate }`.
3. La app hace `POST multipart/form-data` a `uploadUrl` con los campos `file`, `api_key`, `timestamp`, `signature`, `public_id`,
   `allowed_formats`, `overwrite` e `invalidate`, con los **mismos valores** recibidos (la firma cubre todos menos `file` y `api_key`).
   Esta petición va **sin** el header `Authorization`. La firma dura una hora.
4. Cloudinary responde con `secure_url` y `public_id`. La app los manda en `PUT /recetas/{id}` como `imagenUrl` e `imagenPublicId`.
5. La API valida que sean de esa receta y de nuestra cuenta, y los guarda.

En `PUT`: si no se envían `imagenUrl` e `imagenPublicId`, la foto actual se conserva; con ambos en `null` se quita (y se borra en
Cloudinary); deben enviarse siempre juntos. El identificador de la foto es fijo por receta
(`recetario/recetas/{recetaId}`), así que subir otra la reemplaza. Formatos permitidos: jpg, png y webp.
Recomendación para la app: subir JPEG de máximo 1600 px por el lado largo (el plan gratuito acepta hasta 10 MB y 25 megapíxeles).

### Errores

Siempre JSON: `{ "error": "mensaje" }`. En validaciones (`400`) también viene `detalles` con el campo y el motivo.
Códigos usados: `400` datos inválidos · `401` sin token o token inválido · `403` la receta es de otro usuario ·
`404` no existe · `409` id duplicado · `500` error interno.

## Probar con curl

```bash
API=<ApiUrl sin la barra final>

# 1) Registrar (devuelve el token)
curl -X POST "$API/register" -H "Content-Type: application/json" \
  -d '{"nombre":"Ana","correo":"ana@correo.com","password":"Passw0rd123"}'

# 2) Iniciar sesión y guardar el token
TOKEN=$(curl -s -X POST "$API/login" -H "Content-Type: application/json" \
  -d '{"correo":"ana@correo.com","password":"Passw0rd123"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

# 3) Crear una receta
curl -X POST "$API/recetas" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "titulo": "Huevos revueltos",
  "categoria": "desayuno",
  "tiempoMinutos": 10,
  "porciones": 2,
  "ingredientes": [{ "nombre": "Huevo", "cantidad": "4", "unidad": "pzas" }],
  "pasos": ["Bate los huevos", "Cocínalos a fuego bajo"]
}'

# 4) Listar
curl "$API/recetas" -H "Authorization: Bearer $TOKEN"
```

## Conectar la app Kotlin

- **Login y registro:** la app solo usa Retrofit contra `POST /login` y `POST /register`; no necesita ningún SDK de AWS.
- **Retrofit:** `baseUrl` = `ApiUrl` (termina en `/`). Un interceptor de OkHttp agrega `Authorization: Bearer <token>` a cada petición
  cuando hay sesión; las consultas de visitantes van sin token.
- **Fotos:** la subida a Cloudinary usa un cliente OkHttp aparte, **sin** ese interceptor.

## Seguridad (ya incluida)

- Cualquiera puede leer las recetas, pero solo el creador las modifica, elimina o firma su foto: `userId` sale del token firmado,
  nunca del cuerpo de la petición, y se compara con el autor guardado (403 si no coincide).
- La API de Cloudinary firma cada subida con un identificador fijo por receta: nadie puede sobrescribir la foto de otra.
- Contraseñas con hash scrypt y sal aleatoria; el correo es único (condición en DynamoDB).
- El mismo mensaje de error si falla el correo o la contraseña, para no revelar qué cuentas existen.
- Tokens firmados con HMAC-SHA256 y expiración de 24 horas.

## Mejoras para más adelante

- Restringir `AllowOrigins` de CORS si agregas una versión web.
- Cerrar sesión en el servidor (lista de tokens revocados) y renovar tokens con un refresh token.
- Paginación en `GET /recetas`: el catálogo hace un `Scan` de toda la tabla, suficiente para pocas recetas. Con muchas, conviene un
  índice por fecha y paginar.

## Pruebas

```bash
npm install
npm run typecheck
npm test        # vitest: lectura pública, autenticación, propiedad (401/403/404), fotos y firma de Cloudinary
```

Las pruebas usan una tabla simulada en memoria; no tocan AWS ni Cloudinary.

## Eliminar todo

```bash
sam delete --stack-name recetario-api
```

Borra la API, las Lambdas y las dos tablas (incluidos los datos).
