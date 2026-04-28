# NightPay — Setup (qué tienes que hacer tú)

El scaffold está listo. Esto es exactamente lo que necesitas hacer antes de `pnpm dev`.

---

## 1. Instalar Node 20 LTS

Tu sistema tiene **Node 25** — demasiado nuevo; el proyecto está fijado a Node 20 LTS (ver `.nvmrc`).

**Opción recomendada: nvm-windows**
```powershell
# Descargar instalador desde: https://github.com/coreybutler/nvm-windows/releases
# Tras instalar, en PowerShell:
nvm install 20.17.0
nvm use 20.17.0
node -v   # v20.17.0
```

**Alternativa**: volta (https://volta.sh) o reinstalar manualmente Node 20 desde https://nodejs.org.

## 2. Habilitar pnpm 9

Node 20 trae `corepack`. Una sola vez:

```powershell
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm -v   # 9.12.0
```

Si corepack no funciona:
```powershell
npm install -g pnpm@9.12.0
```

## 3. Arrancar Docker Desktop

Ya lo tienes instalado (Docker 29.3.0 detectado). Solo verifica que el daemon esté corriendo:
```powershell
docker ps   # no debe dar error
```

## 4. Bootstrap

Desde la raíz del proyecto:

```powershell
cd c:\Users\mehdi\Documents\GitHub\first_tries\nightpay
.\scripts\bootstrap.ps1          # Windows PowerShell
# o
bash scripts/bootstrap.sh        # Git Bash / WSL
```

> **Nota de puerto**: el Postgres de NightPay se mapea al host en `:5433` (no `:5432`)
> porque probablemente ya tengas otro Postgres en `:5432` (ej. chatwoot). La `DATABASE_URL`
> en `.env.example` ya apunta a `localhost:4432`.

El script hace todo:
- Copia `.env.example` → `.env.local`
- Levanta Postgres + Redis vía Docker Compose
- `pnpm install` (genera `pnpm-lock.yaml` la primera vez)
- `pnpm --filter @nightpay/db generate` (cliente Prisma)
- `pnpm --filter @nightpay/db migrate:dev --name init` (crea tablas)
- `pnpm --filter @nightpay/db seed` (crea venue demo + usuarios)
- Arranca los mocks Wipay/Peanpe

**Tiempo esperado primera vez**: 3–5 min (descarga imágenes Docker + deps npm).

## 5. Arrancar todo en dev

```powershell
pnpm dev
```

Esto lanza en paralelo (Turborepo):
- `@nightpay/api` → `http://localhost:4100`
- `@nightpay/web-client` → `http://localhost:4101`
- `@nightpay/tpv` → `http://localhost:4102`
- `@nightpay/admin` → `http://localhost:4103`

Si prefieres un solo servicio a la vez:
```powershell
pnpm --filter @nightpay/api dev
```

## 6. Verificar el hito de Sprint 1

```bash
bash scripts/verify-sprint1.sh
```

Debe ver 20+ checks en verde. El último bloque (runtime) solo pasa si tienes Docker arriba y `pnpm dev` corriendo.

Verificaciones manuales rápidas:
```powershell
curl http://localhost:4100/v1/health
# { "status": "ok", "version": "0.0.0", "checks": { "api": "ok", ... } }

# Abrir los 3 frontends en el navegador
start http://localhost:4101
start http://localhost:4102
start http://localhost:4103
```

## 7. Commit del lockfile

La primera vez que ejecutes `pnpm install` se crea `pnpm-lock.yaml`. **Committearlo**:

```powershell
git add pnpm-lock.yaml
git commit -m "chore: lockfile inicial NightPay Sprint 1"
```

CI usa `--frozen-lockfile` a partir de ese momento.

---

## Troubleshooting

### "Cannot find module '@nightpay/contracts'"
Ejecuta: `pnpm install` desde la raíz `nightpay/`.

### "Prisma Client did not initialize yet"
Ejecuta: `pnpm --filter @nightpay/db generate`.

### "Port 3000/5432/6379 already in use"
```powershell
# Ver qué lo ocupa
netstat -ano | findstr :3000
# Matar proceso
taskkill /PID <pid> /F
```

### Docker Compose build de mocks tarda mucho
Los mocks son opcionales. Puedes saltártelos:
```powershell
docker compose up -d postgres redis  # solo infra
pnpm --filter @nightpay/mock-wipay dev  # correr mock sin docker
```

### Reset total (desarrollo limpio)
```powershell
docker compose down -v   # borra volúmenes (pierdes datos)
pnpm clean
pnpm install
.\scripts\bootstrap.ps1
```

### Node 25 me da `ERR_REQUIRE_ESM`
Estás en Node 25; vuelve a Node 20 LTS (ver paso 1). Muchas libs (Prisma, NestJS 10) no están probadas con Node 25.

---

## Qué NO tienes que hacer

- No crees cuentas en Wipay/Peanpe aún — los mocks responden en dev
- No despliegues a Hetzner todavía — Sprint 6 cubre eso
- No manejes secretos reales — `.env.local` con placeholders basta

---

## Sprint 2 — Auth + Multi-tenancy (ya implementado)

Auth JWT + multi-tenant con RLS ya está cableado. Para probarlo:

### 1. Re-instalar deps (se añadieron libs)

```powershell
pnpm install
```

### 2. Re-generar cliente Prisma

```powershell
pnpm db:generate
```

### 3. Aplicar nueva migración (RLS policies)

```powershell
pnpm --filter @nightpay/db exec prisma migrate dev
```

Debería detectar el migration folder `20260422235959_enable_rls` y aplicarlo.

### 4. Re-sembrar datos (6 venues + owner + 4 managers)

```powershell
pnpm db:seed
```

### 5. Probar login

```powershell
# arrancar API en una ventana
pnpm --filter @nightpay/api dev

# en otra ventana, login como owner
curl -X POST http://localhost:4100/v1/auth/login `
  -H "Content-Type: application/json" `
  -d '{"email":"owner@nightpay.local","password":"nightpay-dev-2026"}'
```

Esperado:
```json
{
  "accessToken": "eyJhbGci...",
  "expiresIn": 43200,
  "user": {"id":"...","email":"owner@nightpay.local","role":"OWNER","tenantId":"...","venueSlug":"luna-vlc"}
}
```

### 6. Probar endpoint autenticado

```powershell
$TOKEN = "eyJhbGci..."   # pega el accessToken aquí

# mi venue (OWNER ve luna-vlc porque es su venue por defecto)
curl http://localhost:4100/v1/venues/me -H "Authorization: Bearer $TOKEN"

# terminales del venue (multi-tenant filtrado automático via Prisma middleware)
curl http://localhost:4100/v1/venues/me/terminals -H "Authorization: Bearer $TOKEN"

# staff del venue (solo OWNER/MANAGER)
curl http://localhost:4100/v1/venues/me/staff -H "Authorization: Bearer $TOKEN"
```

### 7. CLI para gestionar venues (uso diario)

```powershell
# Ver venues existentes
pnpm cli list-venues

# Crear nuevo venue
pnpm cli create-venue --name "Luna Bilbao" --slug luna-bio

# Añadir un manager
pnpm cli create-manager --venue luna-bio --email manager.bio@nightpay.local --password "tu-password-fuerte"

# Listar usuarios de un venue
pnpm cli list-users --venue luna-vlc

# Añadir terminal (datafono)
pnpm cli create-terminal --venue luna-bio --external-id BARRA-1 --label "Barra principal"

# Reset password
pnpm cli reset-password --email manager.vlc@nightpay.local --password "nuevo-pwd"
```

### 8. Credenciales dev (cámbialas ANTES de producción)

- password dev: `nightpay-dev-2026`
- owner: `owner@nightpay.local`
- managers: `manager.{vlc,mad,mrb,ibz}@nightpay.local`

Usa `pnpm cli reset-password` para rotarlas.

## Sprint 3 + Sprint 4 (ya implementado)

Pagos core + integración pasarela ya cableados. Para arrancarlo:

### 1. Reinstalar deps (añadidos: bullmq, ioredis, qrcode, xstate, @nestjs/bullmq)

```powershell
pnpm install
```

### 2. (No hace falta migración nueva — el schema sigue igual.)

### 3. Reiniciar API

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
.\scripts\dev-api.ps1
```

Esperado en el log: `Mapped {/v1/payments, POST}`, `Mapped {/v1/webhooks/:provider, POST}`, etc.

### 4. Crear un pago (en ventana 2)

```powershell
cd C:\Users\mehdi\Documents\GitHub\first_tries\nightpay

$body = @{ email='owner@nightpay.local'; password='nightpay-dev-2026' } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri http://localhost:4100/v1/auth/login -ContentType 'application/json' -Body $body
$token = $r.accessToken

$payment = @{ amountCents=4850; terminalExternalId='BARRA-1' } | ConvertTo-Json
$idempotencyKey = [guid]::NewGuid().ToString()
$created = Invoke-RestMethod -Method Post -Uri http://localhost:4100/v1/payments `
  -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $token"; 'Idempotency-Key' = $idempotencyKey } `
  -Body $payment

$created | ConvertTo-Json -Depth 5
```

Esperado: JSON con `id`, `qrToken`, `qrUrl`, `qrPngDataUrl` (data URL del PNG), `qrExpiresAt`.

### 5. Verificar el pago (lookup público por token)

```powershell
$publicView = Invoke-RestMethod -Uri "http://localhost:4100/v1/payments/public/$($created.qrToken)"
$publicView | ConvertTo-Json
```

Esperado: importe + venueName + terminalLabel + status `CREATED`.

### 6. Ver el QR PNG en el navegador

Pega `$created.qrPngDataUrl` en la barra de direcciones del navegador. Verás un QR código.

### 7. Test E2E con mock Wipay (autorización + webhook)

Llama directamente al mock de Wipay con el `qrToken` (el mock-wipay manda webhook al API automáticamente):

```powershell
$ref = $created.id    # el adapter mapea reference → paymentId
Invoke-RestMethod -Method Post -Uri http://localhost:4901/v1/authorize `
  -ContentType 'application/json' `
  -Body (@{ reference=$ref; amount=4850; currency='EUR' } | ConvertTo-Json)

# Espera 2-3 segundos a que mock-wipay envíe webhook…
Start-Sleep -Seconds 3

# El pago debería estar en estado AUTHORIZED ahora
$detail = Invoke-RestMethod -Uri "http://localhost:4100/v1/payments/$($created.id)" `
  -Headers @{ Authorization = "Bearer $token" }
$detail | ConvertTo-Json
```

Esperado: `status: "AUTHORIZED"`, `providerTxId` poblado.

> Nota: el FSM por diseño no permite CREATED → AUTHORIZED directo (esperaría AUTHORIZING primero).
> En Sprint 5 añadiremos un endpoint `POST /v1/payments/public/:token/start-authorization` que mueve a AUTHORIZING. Por ahora el test E2E del flujo completo viene en Sprint 5.

### 8. Test de expiración de QR

Crea un pago con `qrExpiresAt` cerca y espera 5 min — pasará a `EXPIRED` automáticamente vía BullMQ.
O en código: cambia `QR_TTL_SECONDS` en `payments.service.ts` a 30 segundos para testing.

## Sprint 5 (ya implementado): UI real + Socket.io + autorización end-to-end

### 1. Reinstalar deps (socket.io + Redis adapter + socket.io-client)

```powershell
pnpm install
```

### 2. Reiniciar API

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
.\scripts\dev-api.ps1
```

Esperado en logs: `Socket.io Redis adapter wired` + ruta `POST /v1/payments/public/:token/start-authorization`.

### 3. Arrancar TPV (otra ventana)

```powershell
cd C:\Users\mehdi\Documents\GitHub\first_tries\nightpay
pnpm --filter "@nightpay/tpv" dev
```

Abre [http://localhost:4102](http://localhost:4102), login con
`owner@nightpay.local` / `nightpay-dev-2026`. Selecciona "Barra 1", importe 48.50, "Cobrar".

### 4. Arrancar web-client (otra ventana)

```powershell
cd C:\Users\mehdi\Documents\GitHub\first_tries\nightpay
pnpm --filter "@nightpay/web-client" dev
```

### 5. Test flujo completo

1. TPV → crear cobro 48.50€ → ves QR
2. En otro navegador (o móvil), abre el `qrUrl` (algo como `http://localhost:4101/pay/<token>`)
3. Verás importe + venue + terminal. Click **"Pagar ahora"**
4. Estado → `AUTHORIZING` en ambas pantallas (sincronización por WS)
5. Mock-wipay envía webhook async → FSM `AUTHORIZED`
6. **TPV** emite beep + "✓ Cobrado"
7. **Móvil** muestra "✓ Pago completado"

Todo en ~2 segundos. Sin recargar.

### 6. Hardening operativo

Ver [HARDENING.md](HARDENING.md):
- Rotar passwords del seed (`pnpm cli reset-password`)
- Backup diario (`scripts/backup-db.ps1`)
- Monitor pagos atascados (`scripts/check-stuck-payments.ps1`)
- ACL del `.env.local`

## Sprint 6 (ya implementado): admin + reembolsos + reconciliation + health real

### 1. Reinstalar deps + reiniciar API

```powershell
pnpm install
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
.\scripts\dev-api.ps1
```

Rutas nuevas:
- `POST /v1/payments/:id/refunds`
- `GET  /v1/payments/:id/refunds`
- `GET  /v1/admin/payments`
- `GET  /v1/admin/metrics`

### 2. Health real

```powershell
curl.exe http://localhost:4100/v1/health
```

Debe decir `db: ok` y `redis: ok` (no `skip`).

### 3. Admin dashboard (otra ventana)

```powershell
cd C:\Users\mehdi\Documents\GitHub\first_tries\nightpay
pnpm --filter "@nightpay/admin" dev
```

[http://localhost:4103](http://localhost:4103) → login con `owner@nightpay.local` / `nightpay-dev-2026`.

Vista:
- Tiles métricas (hoy + semana, neto destacado)
- Tabla pagos con filtro por status, refresh 5s
- Botón **Reembolsar** en AUTHORIZED/PARTIALLY_REFUNDED
- Modal con importe + razón + (si ≥ 100 €) código TOTP

### 4. Test refund E2E

1. TPV: crear pago 48.50 € + pagar → AUTHORIZED
2. Admin: click "Reembolsar" → importe `12.50` → confirmar → PARTIALLY_REFUNDED, available 36.00 €
3. Reembolsar otros `36.00` → REFUNDED

Verifica en DB:
```powershell
docker exec -i nightpay_postgres psql -U np -d nightpay -c 'SELECT "amountCents", status, "providerRefundId" FROM refunds ORDER BY "createdAt" DESC LIMIT 5;'
```

### 5. Reconciliation diaria

Scheduler programa job repetible 07:00 UTC para cada venue. Estado en tabla `reconciliations`.

## Próximos pasos (Sprint 7+)

- 2FA TOTP real (speakeasy) — ahora es placeholder
- Audit log global (role changes, credentials, refunds)
- Despliegue Hetzner + Coolify + Cloudflare
- Integración Wipay/Peanpe real con credenciales descifradas por venue
- CLI `reconcile --day --venue`
