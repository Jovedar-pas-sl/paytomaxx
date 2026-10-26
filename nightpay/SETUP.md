# NightPay — Setup local (qué tienes que hacer tú)

Lo que hace falta para tener el entorno de desarrollo en tu equipo y probar el
API a mano. Despliegue en producción: [docs/DOKPLOY-STEPS.md](docs/DOKPLOY-STEPS.md).

Los comandos van desde la carpeta `nightpay/` de tu copia del repositorio.

---

## 1. Node 22 y pnpm 9

El proyecto pide **Node 22** (`.nvmrc`: `22.23.3`; `package.json`: `"node": ">=22.0.0"`).
Con nvm-windows, nvm o volta:

```powershell
nvm install 22.23.3
nvm use 22.23.3
node -v   # v22.23.3
```

pnpm 9.12.0 con `corepack` (viene con Node). Una sola vez:

```powershell
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm -v   # 9.12.0
```

Si corepack no funciona: `npm install -g pnpm@9.12.0`.

## 2. Docker

Docker Desktop (o Docker + Compose) arrancado: `docker ps` no debe dar error.

`docker-compose.yml` (solo desarrollo) levanta, en estos puertos del equipo:

| Servicio | Puerto |
|----------|-------:|
| Postgres 16 | 4432 |
| Redis 7 | 4379 |
| Mailpit (correo de pruebas) | 4825 (web) · 4525 (SMTP) |
| mock-wipay | 4901 (ver [Simuladores](#simuladores-de-pasarela)) |
| mock-peanpe | 4902 |

`.env.example` ya apunta a `localhost:4432` (Postgres) y `localhost:4379` (Redis).

## 3. Bootstrap

```powershell
.\scripts\bootstrap.ps1          # Windows PowerShell
# o
bash scripts/bootstrap.sh        # Git Bash / WSL / macOS / Linux
```

El script:
- copia `.env.example` → `.env.local` (si no existe);
- levanta Postgres y Redis con Docker Compose;
- `pnpm install`;
- `pnpm --filter @nightpay/db generate` (cliente Prisma);
- aplica las migraciones (`prisma migrate dev`);
- `pnpm --filter @nightpay/db seed` (locales demo, usuarios, terminales);
- intenta levantar `mock-wipay` y `mock-peanpe` (opcionales).

## 4. Arrancar en desarrollo

```powershell
pnpm dev
```

Turborepo lanza en paralelo el `dev` de cada paquete:
- `@nightpay/api` → http://localhost:4100 (antes repara la base con `db heal`)
- `@nightpay/web-client` → http://localhost:4101
- `@nightpay/tpv` → http://localhost:4102
- `@nightpay/admin` → http://localhost:4103
- `@nightpay/operator` → http://localhost:4104
- `@nightpay/mock-wipay` y `@nightpay/mock-peanpe` fuera de Docker (puertos 3000 y 3001 por defecto)

Un solo servicio: `pnpm --filter @nightpay/api dev`.

Comprobar:

```powershell
curl http://localhost:4100/v1/health
# { "status": "ok", …, "checks": { "api": "ok", "db": "ok", "redis": "ok" } }   (503 si falla la base o Redis)
```

`bash scripts/verify-sprint1.sh` repasa ficheros del monorepo y, con todo
arrancado, Postgres en :4432, Redis en :4379 y `/v1/health`.

## 5. Usuarios del seed

- dueño: `owner@nightpay.local` (local `luna-vlc`)
- encargados: `manager.{vlc,mad,mrb,ibz}@nightpay.local`
- contraseña: la de `SEED_PASSWORD` en `.env.local` (mín. 12 caracteres) o, si
  no hay, una al azar que el seed enseña una sola vez al final.

El seed solo crea lo que falta y **nunca cambia la contraseña de un usuario que
ya existe**. En producción no se usa (ni va en la imagen). Si la pierdes:
`pnpm cli reset-password --email <correo>` (la pide sin enseñarla).

## 6. Sesión: login y token de acceso

```powershell
curl -X POST http://localhost:4100/v1/auth/login `
  -H "Content-Type: application/json" `
  -d '{"email":"owner@nightpay.local","password":"<la del seed>"}'
```

Respuesta:

```json
{
  "accessToken": "eyJhbGci...",
  "expiresIn": 3600,
  "refreshExpiresIn": 2592000,
  "user": { "id": "...", "email": "owner@nightpay.local", "role": "OWNER", "tenantId": "...", "venueSlug": "luna-vlc", "isSuperAdmin": false, "displayName": null }
}
```

- El **token de acceso** (JWT) dura **1 h** (`expiresIn: 3600`). Las apps lo
  renuevan solas con el refresh.
- El **refresh** dura 30 días, cambia en cada uso y la sesión vive como mucho
  90 días desde el login. Las apps (cabecera `X-OxioPay-Client`) lo reciben en
  una cookie HttpOnly; una petición sin esa cabecera, como este `curl`, lo
  recibe en el cuerpo (`refreshToken`) solo hasta `AUTH_BODY_REFRESH_UNTIL`
  (por defecto 2026-12-01 12:00 de Madrid).
- Cerrar una sesión corta su token de acceso **al momento** (401
  `SESSION_REVOKED`): salir (`/v1/auth/logout`), revocar las sesiones de alguien
  (`POST /v1/admin/users/:userId/revoke-sessions`, la consola del super-admin o
  `pnpm cli revoke-sessions`), darle de baja o resetearle la contraseña. Si el
  API no puede comprobarlo porque Redis no responde, contesta 503 (no 401): nadie
  pierde la sesión y se vuelve a probar.

Con el token:

```powershell
$TOKEN = "eyJhbGci..."   # el accessToken

curl http://localhost:4100/v1/venues/me -H "Authorization: Bearer $TOKEN"
curl http://localhost:4100/v1/venues/me/terminals -H "Authorization: Bearer $TOKEN"
curl http://localhost:4100/v1/venues/me/staff -H "Authorization: Bearer $TOKEN"
```

## 7. Crear un cobro y ver la página de pago

```powershell
$body = @{ email='owner@nightpay.local'; password='<la del seed>' } | ConvertTo-Json
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:4100/v1/auth/login -ContentType 'application/json' -Body $body).accessToken

$payment = @{ amountCents=4850; terminalExternalId='BARRA-1' } | ConvertTo-Json
$created = Invoke-RestMethod -Method Post -Uri http://localhost:4100/v1/payments `
  -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $token"; 'Idempotency-Key' = [guid]::NewGuid().ToString() } `
  -Body $payment
$created | ConvertTo-Json -Depth 5
```

Devuelve `id`, `qrToken`, `qrUrl`, `qrPngDataUrl` (el QR en PNG) y `qrExpiresAt`
(el QR caduca a los 5 min: pasa a `EXPIRED` solo, con BullMQ).

`qrUrl` es `NEXT_PUBLIC_WEB_CLIENT_URL/pay/<token>` (en local,
http://localhost:4101/pay/<token>); la web del cliente redirige a la página de
pago del API (http://localhost:4100/pay/<token>), que es la de verdad: importe,
propina y botones. Al pulsar «Pagar» se abre el pago en la pasarela activa del
local y el cliente va a la página del banco; el cobro pasa a pagado cuando llega
el aviso firmado del banco al API (`/v1/webhooks/…`; Redsys lo manda a
`NEXT_PUBLIC_API_URL/v1/webhooks/redsys`, así que desde el banco de verdad solo
llega con una URL pública).

La pasarela que crea el seed es un Wipay de relleno: sin las variables
`WIPAY_*` en `.env.local`, «Pagar» no puede abrir el pago y la página lo dice
(«No se ha podido abrir el pago», sin botón de reintentar; el cobro queda
`FAILED`). Si el fallo de la pasarela es pasajero (no responde, 5xx), el cobro
sigue pendiente y «Intentar otra vez» sí lo reintenta. Para otra pasarela:
`pnpm cli set-redsys-active --venue luna-vlc` (con las variables `REDSYS_*`),
`set-wipay-active` o `set-peanpe-active`.

Lookup público del cobro (lo que consulta el TPV):

```powershell
Invoke-RestMethod -Uri "http://localhost:4100/v1/payments/public/$($created.qrToken)" | ConvertTo-Json
```

### Simuladores de pasarela

`apps/mock-wipay` (puerto 4901) y `apps/mock-peanpe` (4902) son solo para
desarrollo y nunca van a producción. **mock-wipay ya no sirve para cerrar un
cobro**: manda sus avisos en el formato antiguo (JSON con `X-Signature`) y el
adaptador de Wipay de hoy habla el de Cecabank (`MerchantID`, `Num_operacion`,
`Firma`…), así que el API los rechaza (`$*$NOK$*$`) y el cobro no pasa a pagado.
El paso de un aviso del banco a «pagado» lo cubren las pruebas de integración
(`apps/api/test/integration/pasarelas.int.spec.ts`, con avisos de Redsys firmados).

## 8. CLI

```powershell
pnpm cli list-venues
pnpm cli create-venue    --name "Luna Bilbao" --slug luna-bio
pnpm cli create-manager  --venue luna-bio --email manager.bio@nightpay.local
pnpm cli list-users      --venue luna-vlc
pnpm cli create-terminal --venue luna-bio --external-id BARRA-1 --label "Barra principal"
pnpm cli reset-password  --email manager.vlc@nightpay.local
pnpm cli revoke-sessions --email manager.vlc@nightpay.local   # móvil perdido: corta también su token de acceso
```

Las contraseñas (`create-*`, `reset-password`) se piden sin que se vean, o con
`NP_PASSWORD=... pnpm cli ...`; `--password` sigue valiendo pero queda en el
historial de la terminal. `pnpm cli --help` lista todos los comandos.

## 9. Pruebas

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @nightpay/api test:integration   # Postgres de pruebas: apps/api/test/integration/README.md
```

---

## Troubleshooting

### "Cannot find module '@nightpay/contracts'"
`pnpm install` desde `nightpay/`.

### "Prisma Client did not initialize yet"
`pnpm db:generate`.

### Puerto ocupado (4100–4104, 4432, 4379…)
```powershell
netstat -ano | findstr :4100
taskkill /PID <pid> /F
```

### No quiero los simuladores
Son opcionales: `docker compose up -d postgres redis` levanta solo la infraestructura.

### Reset total (desarrollo limpio)
```powershell
docker compose down -v   # borra los volúmenes (pierdes los datos)
pnpm clean
pnpm install
.\scripts\bootstrap.ps1
```

### Otra versión de Node
El proyecto pide Node 22 (ver paso 1).

---

## Qué NO tienes que hacer en local

- No manejes secretos reales: `.env.local` con los valores de `.env.example` basta.
- No despliegues desde aquí: ver [docs/DOKPLOY-STEPS.md](docs/DOKPLOY-STEPS.md).
- Operación (contraseñas, copias, cobros atascados): [HARDENING.md](HARDENING.md) y
  [docs/runbooks/](docs/runbooks/).
