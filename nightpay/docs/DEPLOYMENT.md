> ## ⚠️ OBSOLETO — no lo sigas
>
> Este documento describe un despliegue con Coolify que ya no se usa. El
> despliegue vigente es Dokploy: **[DOKPLOY-STEPS.md](DOKPLOY-STEPS.md)**
> (copias en [BACKUPS.md](BACKUPS.md), incidentes en [runbooks/](runbooks/)).
> Se conserva solo como histórico.

# NightPay — Deployment guide (Hetzner VPS + Dockploy/Coolify + Cloudflare + Grafana Cloud)

> **Nota**: este doc usa Coolify en los ejemplos. Si usas Dockploy (recomendado tambien),
> los pasos son identicos — el flujo de "crear app desde GitHub + variables de entorno + ports"
> es el mismo. Sustituye "Coolify UI" por "Dockploy UI" mentalmente.

Pasos concretos, en orden, para llevar NightPay de local a Internet.

**Prerequisitos**
- VPS Hetzner provisionado (Ubuntu 22.04 LTS recomendado)
- SSH key configurada (ya deberias poder `ssh root@TU_IP`)
- Dominio comprado (puede ser .com, .es, lo que sea — recomiendo Cloudflare Registrar o Namecheap)
- 30-60 min de tiempo

---

## Fase 1 — Coolify en el VPS (15 min)

Coolify = self-hosted Heroku. Auto-deploy desde Git push, blue/green, SSL automatico, gestiona Postgres y Redis como servicios managed.

### 1.1 Hardening basico del VPS (antes de tocar nada mas)

```bash
ssh root@TU_VPS_IP

# Actualizar
apt update && apt upgrade -y

# Crear usuario no-root
adduser nightpay
usermod -aG sudo nightpay
# Copiar ssh keys del root al nuevo usuario
rsync --archive --chown=nightpay:nightpay ~/.ssh /home/nightpay

# UFW firewall — permitir solo lo necesario
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp        # SSH
ufw allow 80/tcp        # HTTP (Cloudflare → Coolify)
ufw allow 443/tcp       # HTTPS
ufw allow 8000/tcp      # Coolify UI (cerrar despues via Cloudflare Access)
ufw enable
ufw status

# Fail2ban para SSH brute force
apt install -y fail2ban
systemctl enable fail2ban

# Deshabilitar login root via SSH (despues de verificar que `ssh nightpay@IP` funciona)
sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd
```

### 1.2 Instalar Coolify

```bash
ssh nightpay@TU_VPS_IP
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

Tarda ~5-10 min. Al final imprime la URL inicial (http://IP:8000).

### 1.3 Setup inicial Coolify

1. Abrir `http://TU_VPS_IP:8000` en el navegador
2. Crear cuenta admin (email + password — ESTE ES EL ROOT DE TU INFRA, contraseña fuerte)
3. Generar SSH key del Coolify y añadirla a tu repo GitHub (Settings → Deploy keys, read-only)
4. Conectar GitHub via OAuth app o Personal Access Token

### 1.4 Crear los servicios

En Coolify UI → Resources → New:

**Postgres 16**
- Tipo: Postgres
- Version: 16
- Database name: `nightpay`
- Username: `np`
- Password: generar uno fuerte (guardar en password manager)
- Port: deja el default (5432 interno)

**Redis 7**
- Tipo: Redis
- Version: 7
- Password: generar uno fuerte
- Persistence: enabled
- maxmemory-policy: `noeviction` (CRITICO para BullMQ — sin esto pierdes jobs)

**Application — NightPay API**
- Source: tu repo GitHub
- Branch: `main`
- Build pack: Dockerfile (necesitamos crear uno) o Nixpacks
- Health check path: `/v1/health`
- Port: 4100

Para los frontends, crear 3 apps separadas (admin, tpv, web-client) o una unica con multiple ports.

### 1.5 Variables de entorno (en Coolify UI por cada app)

```env
# Database (Coolify auto-inyecta DATABASE_URL si conectas el Postgres como service)
DATABASE_URL=postgresql://np:PASSWORD@nightpay-postgres:5432/nightpay

# Redis
REDIS_URL=redis://:PASSWORD@nightpay-redis:6379

# Secrets — GENERAR NUEVOS, NO usar los de .env.local
JWT_SECRET=GENERAR_64_CHARS_HEX
ENCRYPTION_KEK=GENERAR_64_CHARS_HEX

# Pasarelas (vacias hasta tener credentials reales)
WIPAY_API_URL=https://api.wipay.es/v2
WIPAY_WEBHOOK_SECRET=PENDIENTE
PEANPE_API_URL=https://api.peanpe.com/v1
PEANPE_WEBHOOK_SECRET=PENDIENTE

# CORS
CORS_ORIGINS=https://app.tudominio.com,https://tpv.tudominio.com,https://admin.tudominio.com

# URLs frontends
NEXT_PUBLIC_API_URL=https://api.tudominio.com
NEXT_PUBLIC_WS_URL=wss://api.tudominio.com

# Misc
NODE_ENV=production
PORT=4100
GATEWAY_TIMEOUT_MS=5000
LOG_LEVEL=info
```

Generar secretos:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Fase 2 — Cloudflare (15 min)

### 2.1 Añadir dominio a Cloudflare

1. cloudflare.com → Sign up (free plan)
2. Add Site → escribir `tudominio.com` → Free plan
3. Cloudflare escanea registros DNS existentes
4. Te da 2 nameservers (algo como `xxx.ns.cloudflare.com`)
5. Ir al registrador (Namecheap/donde lo compraste) → cambiar nameservers a los de Cloudflare
6. Esperar propagacion (5min - 4h, normalmente ~10min)

### 2.2 Crear DNS records

En Cloudflare → DNS → Records → Add:

| Type | Name | Content | Proxy | TTL |
|------|------|---------|-------|-----|
| A | api | TU_VPS_IP | ✅ orange | Auto |
| A | admin | TU_VPS_IP | ✅ orange | Auto |
| A | tpv | TU_VPS_IP | ✅ orange | Auto |
| A | app | TU_VPS_IP | ✅ orange | Auto |
| A | grafana | TU_VPS_IP | ✅ orange | Auto |
| A | coolify | TU_VPS_IP | ✅ orange | Auto |
| A | @ | TU_VPS_IP | ✅ orange | Auto |
| CNAME | www | tudominio.com | ✅ orange | Auto |

**Proxy en orange**: Cloudflare actua de WAF + DDoS + cache + SSL. Ningun trafico llega directo a tu IP.

### 2.3 SSL/TLS settings

Cloudflare → SSL/TLS → Overview:
- Modo: **Full (strict)** — encripta CF↔origin con cert valido
- Edge Certificates → Always Use HTTPS: **ON**
- Edge Certificates → HSTS: **Enable** (max-age 6 months, include subdomains)
- Edge Certificates → Minimum TLS Version: **1.2**
- Edge Certificates → Automatic HTTPS Rewrites: **ON**

### 2.4 Origin certificate (para que Coolify use HTTPS hacia CF)

Cloudflare → SSL/TLS → Origin Server → Create Certificate:
- Hostnames: `*.tudominio.com, tudominio.com`
- Certificate Validity: 15 years
- Descargar `certificate.pem` y `privatekey.pem`

En Coolify, cargar estos certs en cada app o configurar Traefik global.

### 2.5 WAF (Web Application Firewall)

Cloudflare → Security → WAF → Managed rules:
- Activar **Cloudflare Managed Ruleset** (free plan incluye OWASP basico)
- Activar **Cloudflare Free Managed Ruleset**

Custom rules (Security → WAF → Custom rules → Create rule):

**Rule 1 — Whitelist IPs Wipay para webhooks**
```
(http.host eq "api.tudominio.com" and http.request.uri.path eq "/v1/webhooks/wipay") and not (ip.src in {1.2.3.4 5.6.7.8})
```
Action: Block. Sustituir IPs por las que te de Wipay.

**Rule 2 — Mismo para Peanpe**
```
(http.host eq "api.tudominio.com" and http.request.uri.path eq "/v1/webhooks/peanpe") and not (ip.src in {9.10.11.12})
```

**Rule 3 — Bloquear paths sensibles desde fuera**
```
(http.request.uri.path contains "/v1/admin" or http.request.uri.path contains "/v1/metrics") and ip.geoip.country ne "ES"
```
Action: Block. Solo permite Espana al admin y metrics.

### 2.6 Rate limiting (incluido en plan free, limited)

Security → WAF → Rate limiting rules:
- 100 req/10s por IP en `/v1/auth/login` → block 5min
- 1000 req/min por IP global → challenge

(NightPay ya tiene su propio rate limit interno, pero CF añade defensa en profundidad)

### 2.7 Page Rules (opcional)

- `coolify.tudominio.com/*` → Cache Level: Bypass + Browser Integrity Check: On
- `*.tudominio.com/v1/metrics` → IP Access Rules → solo permitir IPs de Grafana Agent + tu IP casa

---

## Fase 3 — Grafana Cloud (15 min)

Grafana Cloud Free incluye:
- 10k Prometheus series (NightPay genera ~50, sobra)
- 50 GB logs
- 50 GB traces
- 14 days retention

### 3.1 Crear cuenta

1. grafana.com → Sign up (gratis, no requiere tarjeta)
2. Tier: Free Forever
3. Crear stack: nombre `nightpay` (o como quieras)
4. Region: Frankfurt (mas cercana a Hetzner Helsinki/Falkenstein)

### 3.2 Obtener credentials Prometheus remote_write

Grafana Cloud UI → Stack → Prometheus → Send Metrics:
- URL: `https://prometheus-prod-XX-prod-eu-west-2.grafana.net/api/prom/push`
- Username (instance ID): tipo `123456`
- Password (API key): generar nueva con scope `metrics:write`

Guardar:
```
GRAFANA_REMOTE_WRITE_URL=https://prometheus-prod-XX...
GRAFANA_USERNAME=123456
GRAFANA_API_KEY=glc_xxxxxxxxxxxx
```

### 3.3 Instalar Grafana Agent en el VPS

Grafana Agent scrapea `http://nightpay-api:4100/v1/metrics` cada 30s y empuja a Grafana Cloud.

```bash
ssh nightpay@TU_VPS_IP

# Descargar agent
sudo mkdir -p /etc/grafana-agent
curl -O -L https://github.com/grafana/agent/releases/latest/download/grafana-agent-linux-amd64.zip
unzip grafana-agent-linux-amd64.zip
sudo mv grafana-agent-linux-amd64 /usr/local/bin/grafana-agent
sudo chmod +x /usr/local/bin/grafana-agent

# Config
sudo tee /etc/grafana-agent/config.yaml > /dev/null <<'EOF'
server:
  log_level: info

metrics:
  global:
    scrape_interval: 30s
    external_labels:
      cluster: nightpay-prod
      env: production
  configs:
    - name: nightpay
      scrape_configs:
        - job_name: nightpay-api
          metrics_path: /v1/metrics
          static_configs:
            - targets: ['localhost:4100']
              # O el nombre del container Coolify:
              # - targets: ['nightpay-api:4100']
      remote_write:
        - url: REEMPLAZAR_GRAFANA_REMOTE_WRITE_URL
          basic_auth:
            username: REEMPLAZAR_GRAFANA_USERNAME
            password: REEMPLAZAR_GRAFANA_API_KEY
EOF

# Systemd unit
sudo tee /etc/systemd/system/grafana-agent.service > /dev/null <<'EOF'
[Unit]
Description=Grafana Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/grafana-agent --config.file=/etc/grafana-agent/config.yaml
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable grafana-agent
sudo systemctl start grafana-agent
sudo systemctl status grafana-agent  # verificar que arranco OK
```

Logs si falla:
```bash
sudo journalctl -u grafana-agent -f
```

### 3.4 Crear dashboards

Grafana Cloud UI → Dashboards → Import:

**Dashboard 1 — NightPay Operations**

Panels:
- **Pagos creados/min** — `rate(nightpay_payments_created_total[1m])` agrupado por venue
- **Tasa exito autorizacion** — `sum(rate(nightpay_payments_transitioned_total{to="AUTHORIZED"}[5m])) / sum(rate(nightpay_payments_transitioned_total{from="AUTHORIZING"}[5m]))`
- **Refunds/h** — `rate(nightpay_refunds_created_total[1h])` por status
- **Latencia gateway p95** — `histogram_quantile(0.95, rate(nightpay_gateway_call_duration_seconds_bucket[5m]))` por provider+op
- **Estado circuit breakers** — `nightpay_circuit_state` (color: 0=verde, 1=naranja, 2=rojo)
- **Logins por outcome** — `rate(nightpay_auth_logins_total[5m])` por outcome
- **Webhooks por outcome** — `rate(nightpay_webhooks_received_total[5m])` por provider+outcome
- **Conexiones WS activas** — `nightpay_ws_connections_active`
- **Queue depth BullMQ** — `nightpay_queue_depth` por queue

### 3.5 Alertas criticas (Grafana Cloud → Alerting)

| Alerta | Expresion | Severidad |
|--------|-----------|-----------|
| Circuit breaker open | `nightpay_circuit_state{} == 2` for 1m | P0 |
| Tasa autorizacion <90% | tasa exito <0.9 for 5m | P1 |
| Pago atascado >30min | payments en AUTHORIZING >30m | P0 |
| Login lockouts altos | `rate(nightpay_auth_logins_total{outcome="locked"}[5m]) > 1` | P1 |
| Webhooks invalid >5% | tasa invalid/total >0.05 for 5m | P1 |
| API down | `up{job="nightpay-api"} == 0` for 1m | P0 |

Configurar contact point Telegram (token bot + chat_id) en Grafana → Alerting → Contact points.

---

## Fase 4 — Verificacion end-to-end

### 4.1 Healthchecks publicos

```bash
curl https://api.tudominio.com/v1/health
# → {"status":"ok","checks":{"api":"ok","db":"ok","redis":"ok"}}

curl https://api.tudominio.com/v1/metrics | grep nightpay_
# → debe imprimir las metricas
```

### 4.2 Login + refresh desde produccion

```bash
LOGIN=$(curl -s -X POST https://api.tudominio.com/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@nightpay.local","password":"PASSWORD_ROTADO"}')
echo $LOGIN | jq .
```

### 4.3 Uptime Robot (5 min)

uptimerobot.com → Sign up (free) → Add monitor:
- Type: HTTPS
- URL: `https://api.tudominio.com/v1/health`
- Interval: 5 min
- Alert contacts: tu email + bot Telegram
- Status page publica: si quieres

---

## Troubleshooting comun

**Coolify no arranca**: `sudo systemctl status coolify` y `journalctl -u coolify -f`

**Cloudflare error 502**: origin no responde — verificar `curl http://VPS_IP:80` desde fuera

**Cloudflare error 522**: timeout origen — firewall UFW bloqueando 80/443

**Grafana Agent no envia metrics**: verificar credentials y que el container API expone /v1/metrics:
```bash
curl http://localhost:4100/v1/metrics
```

**SSL cert error en Coolify**: usar Origin Certificate de Cloudflare (Fase 2.4) en vez de Let's Encrypt si CF esta en proxy mode.

---

## Orden ejecucion recomendado

1. ✅ VPS provisionado (ya tienes)
2. **Hardening VPS** (1.1) — 10 min
3. **Coolify install** (1.2-1.3) — 10 min
4. **Comprar dominio** si no lo tienes — 5 min
5. **Cloudflare DNS** (2.1-2.2) — 10 min
6. **SSL Cloudflare** (2.3-2.4) — 5 min
7. **Coolify deploy NightPay con mocks** (1.4-1.5) — 30 min
8. **Verificar** `https://api.tudominio.com/v1/health` (4.1) — 1 min
9. **WAF Cloudflare** (2.5-2.6) — 10 min
10. **Grafana Cloud** (3.1-3.5) — 15 min
11. **Uptime Robot** (4.3) — 5 min
12. **Pedir credentials sandbox a Wipay** — paralelo
