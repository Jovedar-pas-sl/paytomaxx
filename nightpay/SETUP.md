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
> en `.env.example` ya apunta a `localhost:5433`.

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
- `@nightpay/api` → `http://localhost:3100`
- `@nightpay/web-client` → `http://localhost:3101`
- `@nightpay/tpv` → `http://localhost:3102`
- `@nightpay/admin` → `http://localhost:3103`

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
curl http://localhost:3100/v1/health
# { "status": "ok", "version": "0.0.0", "checks": { "api": "ok", ... } }

# Abrir los 3 frontends en el navegador
start http://localhost:3101
start http://localhost:3102
start http://localhost:3103
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
curl -X POST http://localhost:3100/v1/auth/login `
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
curl http://localhost:3100/v1/venues/me -H "Authorization: Bearer $TOKEN"

# terminales del venue (multi-tenant filtrado automático via Prisma middleware)
curl http://localhost:3100/v1/venues/me/terminals -H "Authorization: Bearer $TOKEN"

# staff del venue (solo OWNER/MANAGER)
curl http://localhost:3100/v1/venues/me/staff -H "Authorization: Bearer $TOKEN"
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

## Próximos pasos (Sprint 3)

Tras verificar Sprint 2 (login OK + `/venues/me` OK + CLI OK), Sprint 3 cubre:
- Pagos core: `POST /v1/payments` crea pago + genera QR
- XState FSM con transiciones atómicas
- Job BullMQ `qr-expire`
- Endpoint `GET /v1/payments/:id` (cliente escanea QR)

Di "continúa Sprint 3" cuando estés listo.
