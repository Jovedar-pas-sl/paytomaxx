# NightPay — Deployment paso a paso en Dokploy

Guion concreto para deployar NightPay en tu VPS Contabo (38.242.131.141)
con Dokploy + Cloudflare. Sigue las fases en orden.

---

## Fase 0 — Generar secretos (una sola vez)

En tu maquina local, genera 4 secrets:

```powershell
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ENCRYPTION_KEK
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Postgres password
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# Redis password
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Anotalos en tu password manager. Los necesitaras durante el deploy.

---

## Fase A — Conectar Dokploy a GitHub

1. Dokploy UI → avatar superior derecha → **Settings**
2. **Git Providers** (o similar) → **GitHub** → **Add**
3. Click **Connect with GitHub** → autoriza la app en GitHub
4. **Install GitHub App** → en GitHub elige "Only select repositories" → marca `paytomaxx`

**Verificacion**: vuelve a Dokploy, en Git Providers debe aparecer "GitHub: Connected".

---

## Fase B — Proyecto + Postgres + Redis

### B.1 Crear proyecto

Projects → **Create Project** → name: `nightpay`

### B.2 Postgres

Dentro de `nightpay` → **Create Service** → **Database** → **PostgreSQL**:
- Application Name: `nightpay-postgres`
- Image: `postgres:16-alpine`
- Database name: `nightpay`
- Username: `np`
- Password: el que generaste en Fase 0
- External port: vacio (NO exponer)
- Click Create → Deploy

**Anota** el Internal Host (algo como `nightpay-postgres-xxxxx`).

### B.3 Redis

**Create Service** → **Database** → **Redis**:
- Application Name: `nightpay-redis`
- Image: `redis:7-alpine`
- Password: el de Fase 0
- External port: vacio
- Si Dokploy ofrece campo "Command" o "Args": `--maxmemory-policy noeviction --appendonly yes`
  (si no lo ofrece, saltar — lo arreglamos despues)
- Create → Deploy

**Anota** el Internal Host.

---

## Fase C — Mocks Wipay + Peanpe (mientras llegan credenciales reales)

Los mocks tambien se deployan desde el repo GitHub. Esto permite probar el flujo
de pago E2E en produccion sin credentials reales.

### C.1 Mock Wipay

`nightpay` proyecto → **Create Service** → **Application**:
- Name: `nightpay-mock-wipay`
- Source: GitHub
- Repo: `ainhoanochesdeverano-dotcom/paytomaxx`
- Branch: `main`
- Build Type: **Dockerfile**
- Build Context: `nightpay/apps/mock-wipay`
- Dockerfile: `Dockerfile`
- Port: `3000`
- Domains: vacio (servicio interno solo)
- Deploy

### C.2 Mock Peanpe

Idem pero:
- Name: `nightpay-mock-peanpe`
- Build Context: `nightpay/apps/mock-peanpe`

---

## Fase D — API

### D.1 Crear servicio API

`nightpay` proyecto → **Create Service** → **Application**:
- Name: `nightpay-api`
- Source: GitHub
- Repo: `ainhoanochesdeverano-dotcom/paytomaxx`
- Branch: `main`
- Build Type: **Dockerfile**
- Build Context: `nightpay`
- Dockerfile: `apps/api/Dockerfile`
- Port: `4100`

### D.2 Variables de entorno

En la pestaña **Environment**, pega esto sustituyendo CAMBIAR_X:

```env
NODE_ENV=production
PORT=4100

DATABASE_URL=postgresql://np:CAMBIAR_POSTGRES_PASSWORD@nightpay-postgres:5432/nightpay
REDIS_URL=redis://default:CAMBIAR_REDIS_PASSWORD@nightpay-redis:6379

JWT_SECRET=CAMBIAR_JWT_SECRET_64_HEX
ENCRYPTION_KEK=CAMBIAR_ENCRYPTION_KEK_64_HEX

WIPAY_API_URL=http://nightpay-mock-wipay:3000
WIPAY_WEBHOOK_SECRET=mock-wipay-webhook-secret-32-bytes-of-padding-here-replace-real
PEANPE_API_URL=http://nightpay-mock-peanpe:3000
PEANPE_WEBHOOK_SECRET=mock-peanpe-webhook-secret-32-bytes-of-padding-here-replace-real

CORS_ORIGINS=https://admin.paytomaxx.com,https://tpv.paytomaxx.com,https://app.paytomaxx.com

GATEWAY_TIMEOUT_MS=5000
LOG_LEVEL=info
```

Notas:
- El hostname interno de Postgres en Dokploy suele ser exactamente el "Application Name". Si falla, verifica con `docker network inspect dokploy-network`.
- Redis suele requerir prefijo `default:` antes de la password: `redis://default:PASS@host:port`.

### D.3 Dominio

Pestaña **Domains** → Add:
- Host: `api.paytomaxx.com`
- Path: `/`
- HTTPS: ✅ ON
- Certificate Provider: **Let's Encrypt**
- Path Type: prefix
- Save

### D.4 Deploy

Click **Deploy** → ver logs en tiempo real.

Build tarda 3-5 min la primera vez. Verás:
- `pnpm install --frozen-lockfile` (1-2 min)
- `pnpm --filter @nightpay/db generate` (~10s)
- `pnpm --filter @nightpay/api build` (~30s)
- Image build completo
- Container arranca

**Si ves error "Cannot find module @prisma/client"**: el build no genero Prisma. Ver troubleshooting abajo.

### D.5 Migrar la DB (CRITICO — solo primera vez)

La API necesita las tablas. Ejecuta migraciones desde dentro del container:

```bash
ssh root@38.242.131.141

# Encuentra el container API
docker ps | grep nightpay-api

# Entra al container y migra
docker exec -it $(docker ps -q -f name=nightpay-api) sh
cd /repo
pnpm --filter @nightpay/db migrate
exit
```

Si no funciona dentro del container porque falta `prisma` CLI, ejecuta desde el host con la misma DATABASE_URL:

```bash
# En el host del VPS
docker run --rm --network dokploy-network \
  -e DATABASE_URL="postgresql://np:CAMBIAR_PASSWORD@nightpay-postgres:5432/nightpay" \
  -v $(pwd):/app -w /app \
  node:20-alpine sh -c "
    corepack enable && corepack prepare pnpm@9.12.0 --activate &&
    npx prisma migrate deploy --schema=/dev/stdin
  "
```

(Mas facil: clonar el repo en el VPS y ejecutar las migrations desde alli — siguiente paso opcional)

### D.6 Verificar API

```bash
# Desde el VPS
curl http://localhost:4100/v1/health

# Desde Internet (cuando Cloudflare propague + Lets Encrypt firme cert)
curl https://api.paytomaxx.com/v1/health
```

Esperado:
```json
{"status":"ok","version":"0.0.0","checks":{"api":"ok","db":"ok","redis":"ok"}}
```

### D.7 Seed inicial (crear venues + owner)

```bash
ssh root@38.242.131.141
docker exec -it $(docker ps -q -f name=nightpay-api) sh
cd /repo
pnpm --filter @nightpay/db seed
exit
```

Crea 6 venues + owner + 4 managers con password `nightpay-dev-2026`.

**ROTA EL PASSWORD INMEDIATAMENTE**:
```bash
docker exec -it $(docker ps -q -f name=nightpay-api) sh -c "cd /repo && pnpm cli reset-password --email owner@nightpay.local --password 'PASSWORD_NUEVO_FUERTE'"
```

---

## Fase E — Frontends

Repetir tres veces (admin, tpv, web-client) con los mismos parametros excepto:

| App | Build Context | Dockerfile | Port | Dominio |
|-----|---------------|------------|------|---------|
| admin | `nightpay` | `apps/admin/Dockerfile` | `4103` | `admin.paytomaxx.com` |
| tpv | `nightpay` | `apps/tpv/Dockerfile` | `4102` | `tpv.paytomaxx.com` |
| web-client | `nightpay` | `apps/web-client/Dockerfile` | `4101` | `app.paytomaxx.com` |

Variables de entorno (mismas para los 3):
```env
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://api.paytomaxx.com
NEXT_PUBLIC_WS_URL=wss://api.paytomaxx.com
NEXT_TELEMETRY_DISABLED=1
```

---

## Fase F — Cloudflare SSL strict (despues de Lets Encrypt)

1. Cloudflare → tu sitio → **SSL/TLS** → **Overview**
2. Cambiar de **Full** a **Full (strict)**
3. Verificar `https://api.paytomaxx.com/v1/health` sigue OK

Esto fuerza que CF↔origin use cert valido (que Dokploy ya genero via Lets Encrypt).

---

## Fase G — Grafana Cloud

### G.1 Cuenta Grafana

1. https://grafana.com → Sign up Free (no requiere tarjeta)
2. Stack name: `nightpay`
3. Region: `prod-eu-west-2` (Frankfurt)
4. Te lleva a tu Grafana en `https://nightpay.grafana.net`

### G.2 Get Prometheus credentials

Dentro de tu stack:
1. Sidebar → **Connections** → **Data sources** → **prometheus** (default)
2. Click → **Data source settings**
3. Anota:
   - URL: `https://prometheus-prod-XX-prod-eu-west-2.grafana.net/api/prom`
   - Username (instance ID): un numero, ej `2123456`
4. Sidebar → **My Account** → **Access Policies** → **Add access policy**
   - Name: `nightpay-write`
   - Realm: tu stack
   - Scopes: `metrics:write`
   - Token: Generate → copia `glc_xxxxxxxxxx`

Ahora tienes:
- `GRAFANA_REMOTE_WRITE_URL` (URL anterior + `/push`)
- `GRAFANA_USERNAME`
- `GRAFANA_API_KEY`

### G.3 Instalar Grafana Agent en VPS

```bash
ssh root@38.242.131.141

# Descargar agent
cd /tmp
curl -O -L https://github.com/grafana/agent/releases/download/v0.42.0/grafana-agent-linux-amd64.zip
apt install -y unzip
unzip grafana-agent-linux-amd64.zip
mv grafana-agent-linux-amd64 /usr/local/bin/grafana-agent
chmod +x /usr/local/bin/grafana-agent

# Config
mkdir -p /etc/grafana-agent
nano /etc/grafana-agent/config.yaml
```

Pega esto en `config.yaml` (sustituye los 3 placeholders):

```yaml
server:
  log_level: info

metrics:
  global:
    scrape_interval: 30s
    external_labels:
      cluster: paytomaxx-prod
      env: production
  configs:
    - name: nightpay
      scrape_configs:
        - job_name: nightpay-api
          metrics_path: /v1/metrics
          static_configs:
            - targets: ['nightpay-api:4100']
      remote_write:
        - url: REEMPLAZAR_GRAFANA_REMOTE_WRITE_URL
          basic_auth:
            username: 'REEMPLAZAR_GRAFANA_USERNAME'
            password: 'REEMPLAZAR_GRAFANA_API_KEY'
```

### G.4 Ejecutar agent dentro de la red Dokploy

Como el agent necesita resolver `nightpay-api:4100`, debe correr en la misma
network Docker. Lo mas facil: deployarlo como servicio Dokploy.

**Alternativa simple — Docker run manual**:

```bash
docker run -d \
  --name grafana-agent \
  --network dokploy-network \
  --restart unless-stopped \
  -v /etc/grafana-agent/config.yaml:/etc/agent/config.yaml \
  grafana/agent:v0.42.0 \
  --config.file=/etc/agent/config.yaml

# Verificar
docker logs -f grafana-agent
```

Al cabo de 30-60s deberias ver en los logs algo como:
```
ts=... level=info msg="Scraping target" target=nightpay-api:4100
```

### G.5 Verificar metrics llegan

En Grafana Cloud UI → **Explore** → query:

```promql
nightpay_payments_created_total
```

Si aparece (aunque sea 0), funciona. Si no aparece despues de 1-2min, ver logs del agent.

### G.6 Importar dashboard

1. Grafana Cloud UI → **Dashboards** → **New** → **Import**
2. Upload JSON: `nightpay/docs/grafana-dashboard.json` (esta en el repo)
3. Select datasource: tu Prometheus default
4. Import

10 paneles operativos listos.

### G.7 Alertas P0/P1

Grafana → **Alerting** → **Alert rules** → **New rule**:

| Nombre | Query | For | Severidad |
|--------|-------|-----|-----------|
| API down | `up{job="nightpay-api"} == 0` | 1m | P0 |
| Circuit breaker open | `nightpay_circuit_state >= 2` | 1m | P0 |
| Tasa autorizacion baja | `sum(rate(nightpay_payments_transitioned_total{to="AUTHORIZED"}[5m])) / sum(rate(nightpay_payments_transitioned_total{from="AUTHORIZING"}[5m])) < 0.9` | 5m | P1 |
| Webhooks invalid altos | `sum(rate(nightpay_webhooks_received_total{outcome="invalid"}[5m])) / sum(rate(nightpay_webhooks_received_total[5m])) > 0.05` | 5m | P1 |

Contact point: configura Telegram bot o email.

---

## Troubleshooting comun

### "build context too large" en Dokploy
El monorepo se copia entero. `.dockerignore` ya excluye node_modules/.next. Si aun asi peta, mover apps no usadas a un branch separado.

### "Cannot find module @prisma/client"
El stage `pnpm --filter @nightpay/db generate` falló. Logs del build mostraran el error. Verifica que `packages/db/prisma/schema.prisma` esta en el commit.

### API arranca pero `/v1/health` da 502
Cloudflare puede estar mandando trafico antes de que el container este listo. Espera 1 min. Si persiste:
```bash
docker logs $(docker ps -q -f name=nightpay-api) | tail -50
```

### Lets Encrypt no firma cert
Verificar que Cloudflare proxy NO esta en orange (paradoja: para que Lets Encrypt funcione DESDE el origen, el dominio debe resolver al VPS sin proxy CF temporalmente, O usar HTTP-01 challenge a traves de Traefik).

Workaround: en Cloudflare, desactivar proxy del subdominio `api` durante 5 min (gris en vez de naranja). Dokploy emite cert. Volver a activar proxy.

Alternativa permanente: usar Cloudflare Origin Certificate (ver Fase F del DEPLOYMENT.md).

### Migrations fallan: "P3018 The migration cannot be applied"
Probablemente DB sucia. Drop y recrear:
```bash
docker exec -it $(docker ps -q -f name=nightpay-postgres) psql -U np -d nightpay -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker exec -it $(docker ps -q -f name=nightpay-api) sh -c "cd /repo && pnpm --filter @nightpay/db migrate"
```

---

## Resumen visual del orden

```
┌─────────────────────────────────────────────────┐
│ Fase 0: Generar secretos                        │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase A: Dokploy ↔ GitHub                        │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase B: Postgres + Redis (services Dokploy)     │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase C: Mock Wipay + Peanpe (apps Dokploy)      │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase D: API (app Dokploy + migrate + seed)      │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase E: Frontends admin + tpv + web-client      │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase F: Cloudflare SSL Full (strict)            │
└────────────────┬────────────────────────────────┘
                 ▼
┌─────────────────────────────────────────────────┐
│ Fase G: Grafana Cloud + Agent + dashboard       │
└─────────────────────────────────────────────────┘
```
