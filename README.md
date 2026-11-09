# Recetario API

API REST serverless para la app de recetas en Kotlin.

**Stack:** TypeScript (Node.js 22) · AWS SAM · API Gateway (HTTP API) · Lambda (arm64) · DynamoDB (usuarios y recetas)

```
App Kotlin ──► API Gateway ──► Lambda (valida el token) ──► DynamoDB
                                              ├─ tabla usuarios  (correo, nombre, hash de contraseña)
                                              └─ tabla recetas   (por usuario)
```

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
| Parameter JwtSecret | pega la clave del paso 2 (no se muestra al escribir) |
| Confirm changes before deploy | `N` (o `y` si quieres revisar el cambio) |
| Allow SAM CLI IAM role creation | Enter (`Y`) |
| Disable rollback | Enter (`N`) |
| `<Función> has no authentication. Is this okay?` | **`y`** (aparece una vez por función). Es correcto: la API valida el token dentro de cada Lambda, y `/register` y `/login` deben ser públicas |
| Save arguments to configuration file | Enter (`Y`) |

Tarda unos minutos. Se crean la API, las 7 Lambdas y las tablas de **usuarios** y **recetas** (DynamoDB).

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

`JwtSecret` no se guarda en `samconfig.toml` (por ser secreto), así que se pasa cada vez:

```bash
sam build                # o: sam build -t template-learner-lab.yaml
sam deploy --parameter-overrides JwtSecret="<tu clave>"
```

Usa siempre la misma clave: si cambia, los tokens ya emitidos dejan de ser válidos y los usuarios tendrán que iniciar sesión otra vez.

### Si ya tenías una versión anterior desplegada (con Cognito)

Esta versión no es compatible con ella. Elimínala primero (`sam delete --stack-name <stack-anterior>`) o usa otro
nombre de stack. Los usuarios y recetas anteriores no se conservan.

## Endpoints

`/register` y `/login` son públicos. Las rutas de `/recetas` exigen el header
`Authorization: Bearer <token>` con el `token` que devuelven `/register` y `/login`.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/register` | Guarda el usuario en la base de datos y devuelve la sesión. Body: `{ nombre, correo, password }` |
| POST | `/login` | Inicia sesión. Body: `{ correo, password }` |
| GET | `/recetas` | Lista tus recetas. Filtros opcionales: `?categoria=postre&favorita=true&q=pastel` |
| GET | `/recetas/{id}` | Detalle de una receta |
| POST | `/recetas` | Crea una receta (puedes mandar tu propio `recetaId` UUID) |
| PUT | `/recetas/{id}` | Edita una receta (reemplaza los campos editables) |
| DELETE | `/recetas/{id}` | Elimina la receta |

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

### Errores

Siempre JSON: `{ "error": "mensaje" }`. En validaciones (`400`) también viene `detalles` con el campo y el motivo.
Códigos usados: `400` datos inválidos · `401` sin token · `404` no existe · `409` id duplicado · `500` error interno.

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
- **Retrofit:** `baseUrl` = `ApiUrl` (termina en `/`). Un interceptor de OkHttp agrega `Authorization: Bearer <token>` a cada petición.

## Seguridad (ya incluida)

- Cada usuario solo accede a sus recetas: `userId` sale del token firmado, nunca del cuerpo de la petición.
- Contraseñas con hash scrypt y sal aleatoria; el correo es único (condición en DynamoDB).
- El mismo mensaje de error si falla el correo o la contraseña, para no revelar qué cuentas existen.
- Tokens firmados con HMAC-SHA256 y expiración de 24 horas.

## Mejoras para más adelante

- Restringir `AllowOrigins` de CORS si agregas una versión web.
- Cerrar sesión en el servidor (lista de tokens revocados) y renovar tokens con un refresh token.
- Paginación en `GET /recetas` si algún usuario llega a tener miles de recetas.

## Eliminar todo

```bash
sam delete --stack-name recetario-api
```

Borra la API, las Lambdas y las dos tablas (incluidos los datos).
