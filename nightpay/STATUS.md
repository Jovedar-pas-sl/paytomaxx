# NightPay — Status (2026-04-29)

Documento canonico de "donde estamos". Si lees solo un MD, lee este.

---

## TL;DR

- **Codigo**: feature-complete a nivel local. 99 tests verdes. Stack docker arriba con un comando.
- **Pasarelas reales**: NO conectadas — usamos `mock-wipay` y `mock-peanpe` containers.
- **Deploy**: NO desplegado. Solo corre en tu maquina (Windows) hoy.
- **Bloqueante critico**: necesitas credenciales reales de Wipay y/o Peanpe + un VPS.

---

## 1. Lo que YA esta hecho

### Arquitectura y stack
- Monorepo pnpm + Turborepo: `apps/` (api, web-client, tpv, admin, mock-wipay, mock-peanpe) + `packages/` (db, contracts, config)
- API NestJS 10 + Fastify, Prisma 5 + Postgres 16, Redis 7 + BullMQ
- Frontends Next.js 14 (cliente movil, TPV, admin)
- Docker Compose dev (postgres, redis, mock pasarelas) — `docker compose up -d`

### Autenticacion + autorizacion
- Login email + password (bcrypt 10 rondas)
- JWT 12h + **refresh tokens 30 dias con rotacion + reuso-detection** (Redis)
- 3 kill-switches para movil perdido:
  - HTTP: `POST /v1/admin/users/:userId/revoke-sessions` (OWNER only)
  - CLI: `pnpm cli revoke-sessions --email <email>`
  - Redis directo: `redis-cli --scan --pattern 'nightpay:refresh:user:<id>:*' | xargs redis-cli DEL`
- Login lockout 5 fallos / 15 min (Redis, multi-nodo safe)
- TOTP real (speakeasy) para refunds ≥100€
- Roles: OWNER, MANAGER, WAITER (RBAC declarativo)

### Multi-tenancy (defensa en profundidad)
- App-layer: middleware Prisma que inyecta `tenantId` desde CLS (request scope)
- DB-layer: Postgres RLS policies en 7 tablas
- Cross-tenant lookup explicito via `prisma.asSystem(...)` (login, webhooks, public payment view)

### Flujo de pago
- FSM XState: `CREATED → AWAITING_CAPTURE → AUTHORIZING → AUTHORIZED/FAILED/EXPIRED → REFUNDED/PARTIALLY_REFUNDED + ORPHAN`
- Idempotency key requerido en `POST /payments`
- QR PNG generado server-side (qrcode lib)
- Realtime via Socket.io con Redis adapter (multi-nodo desde dia 1)
- Saga: orphan-reconcile job a 30min si no llega webhook
- Reconciliacion diaria (07:00 UTC) — cron BullMQ con job determinista por venue+provider+day

### Pasarelas (adapter pattern)
- Wipay y Peanpe como adapters intercambiables
- Circuit breaker opossum (50% error rate / 1min → open / 30s reset)
- AbortSignal timeouts (5s)
- AES-256-GCM con KEK para credenciales en DB
- Webhook HMAC SHA-256 timing-safe + ventana anti-replay 5min + idempotencia

### Observabilidad
- Audit log append-only (`audit_events`)
- Prometheus metrics en `GET /v1/metrics`:
  - `nightpay_payments_created_total{venue, provider}`
  - `nightpay_payments_transitioned_total{from, to}`
  - `nightpay_refunds_created_total{venue, provider, status}`
  - `nightpay_auth_logins_total{outcome}`
  - `nightpay_webhooks_received_total{provider, outcome}`
  - `nightpay_gateway_call_duration_seconds{provider, op, outcome}` (histogram)
  - `nightpay_circuit_state{provider, op}` (0=closed, 1=halfOpen, 2=open)
  - + Node.js defaults
- Pino JSON logs estructurados con `traceId`

### Hardening produccion
- @fastify/helmet (CSP)
- @fastify/rate-limit 200 req/min/IP
- CORS via env `CORS_ORIGINS`
- ProblemDetails RFC 7807 (sin stack en prod)
- Body limit 1MB
- Resource limits CPU/memoria en docker-compose

### Tests (99 pasan)
| Suite | Tests |
|-------|------:|
| `payment.machine.spec.ts` | 21 |
| `wipay.adapter.spec.ts` | 19 |
| `refunds.service.spec.ts` | 16 |
| `webhooks.controller.spec.ts` | 12 |
| `refresh-token.service.spec.ts` | 10 |
| `peanpe.adapter.spec.ts` | 9 |
| `auth.service.spec.ts` | 5 |
| `prisma.service.spec.ts` | 5 |
| `health.controller.spec.ts` | 2 |

### CLI ops (`pnpm cli ...`)
- `create-venue / create-owner / create-manager / create-waiter / create-terminal`
- `reset-password`, `list-venues`, `list-users`
- `set-credential` (cifra api_key con AES-256-GCM)
- `enroll-totp` (genera secret + URL otpauth)
- `reconcile --venue --day`
- `revoke-sessions --email` (kill-switch)

### Frontends
- Admin (4103): metricas, listado pagos, refund con TOTP, auto-refresh on 401
- TPV (4102): crear pago, mostrar QR, websocket payment status, auto-refresh on 401
- Web cliente (4101): escanear QR, confirmar pago, ver estado realtime

---

## 2. Lo que falta para PRODUCCION

### A. CRITICO — bloqueante para abrir caja
1. **Credenciales reales pasarelas** (ver §3 abajo)
2. **VPS Hetzner + Coolify** (tienes el VPS, falta provisionar)
3. **Dominio + Cloudflare** (DNS + WAF + SSL)
4. **Backups cron** real (script existe, falta cron VPS)
5. **Rotar passwords seed** (todos los users tienen `nightpay-dev-2026`, ver `HARDENING.md`)
6. **Rotar `JWT_SECRET` y `ENCRYPTION_KEK`** en `.env.production` (los del repo son demo)

### B. ALTO — primeras 2 semanas tras lanzar
1. Auto-failover entre pasarelas (cuando Wipay breaker open → fallback Peanpe)
2. Status page Uptime Robot publico
3. Bot Telegram alertas stuck-payments + breaker open
4. Drill restore mensual (probar PITR funciona)
5. Game day chaos (kill mock, kill Redis, webhook flood)

### C. MEDIO — cuando crezcas
1. Playwright E2E para los 12 escenarios criticos
2. WAL archiving cada 5min → S3 (RPO 5min vs 24h actual)
3. PgBouncer connection pooling (cuando >50k req/dia)
4. 2 nodos API tras balanceador (sticky sessions)
5. Particionado mensual `payment_events` con pg_partman (cuando >100M filas)
6. Replica read-only Postgres para analytics

### D. UX/operacion
1. Frontend admin: pantalla "Sesiones activas por usuario" + boton revoke
2. Frontend admin: ver audit_events recientes
3. Frontend TPV: indicador de "modo degradado" cuando WS cae (fallback polling)
4. Onboarding wizard CLI (asistente para crear venue + owner + terminales)

---

## 3. Credenciales que necesitas obtener

### Wipay (pasarela 1) — REQUERIDA

Lo que hay que pedirles:

| Item | Para que sirve | Cuando |
|------|----------------|--------|
| `API_KEY` produccion | Autorizar pagos | Antes de abrir caja |
| `WEBHOOK_SECRET` | Verificar firmas HMAC de webhooks que recibimos | Antes de abrir caja |
| `API_URL` produccion | Endpoint base (vs sandbox) | Antes de abrir caja |
| URL para REGISTRAR el webhook (su panel) | Decirles donde mandarnos webhooks: `https://api.tudominio.com/v1/webhooks/wipay` | Antes de abrir caja |
| Sandbox credentials | Integration testing antes de prod | YA, para validar |
| Documentacion endpoints exactos | `/v1/authorize`, `/v1/transactions/:id`, `/v1/transactions/:id/refund`, formato webhook (event_type, timestamp, signature) | YA, para verificar adapter |
| Estructura `event_type` real | Sabemos que mapeamos `payment.authorized`, `payment.failed`, `payment.voided` — confirmar exactos | YA |
| Algoritmo HMAC | Asumimos `HMAC-SHA256(secret, "<timestamp>.<rawBody>") = hex en header x-signature`. Confirmar | YA |
| Headers signature | Asumimos `x-signature` y `x-timestamp` en ms epoch. Confirmar nombres reales | YA |
| Ventana de replay | Asumimos 5min. Confirmar si su lib genera el ts | YA |
| IPs origen webhooks | Para whitelist en Cloudflare WAF | Antes de abrir |
| Limites (TPS, monto max, refund window) | Capacidad y casos borde | Antes de abrir |

Comando para configurar tras obtener:
```powershell
pnpm cli set-credential --venue luna-vlc --provider WIPAY --api-key "<API_KEY>"
```

Ademas en `.env.production`:
```
WIPAY_API_URL=https://api.wipay.es/v2
WIPAY_WEBHOOK_SECRET=<secret>
```

### Peanpe (pasarela 2) — RECOMENDADA (failover)

Mismo set de items que Wipay. Necesarios para:
- Failover automatico cuando Wipay tiene un mal momento
- Negociacion de comisiones (poder cambiar de proveedor 50/50 da palanca)
- Continuidad de servicio si Wipay sufre incidente prolongado

Comando configuracion:
```powershell
pnpm cli set-credential --venue luna-vlc --provider PEANPE --api-key "<API_KEY>"
```

`.env.production`:
```
PEANPE_API_URL=https://api.peanpe.com/v1
PEANPE_WEBHOOK_SECRET=<secret>
```

**Recomendacion**: pre-aprovisiona Peanpe en los 2-3 venues con mas volumen (suelen ser el 80% del trafico).

---

## 4. Programas / servicios a integrar

### Infraestructura (paga)
| Servicio | Para que | Coste estimado | Estado |
|----------|----------|----------------|--------|
| **Hetzner VPS** (CX22 o similar) | Hosting API + DB + Redis | 4-8€/mes | ✅ ya tienes |
| **Cloudflare** (Free plan) | DNS + WAF + SSL + DDoS | 0€ | ⏳ falta configurar |
| **Dominio** (.com / .es) | URL produccion | 10-15€/año | ⏳ falta comprar |
| **Backup S3-compatible** (Backblaze B2 / Hetzner Storage Box) | Backups offsite cifrados | 5€/mes | ⏳ falta configurar |
| **Email transaccional** (Resend / Postmark / SendGrid) | Reset password, alertas | 0€ <100/dia | Opcional |

### Observabilidad (gratis para tu escala)
| Servicio | Para que | Coste | Estado |
|----------|----------|-------|--------|
| **Uptime Robot** (Free) | Status page publico + alertas /health | 0€ | ⏳ |
| **Grafana Cloud** (Free) | Dashboards de metricas Prometheus | 0€ <10k series | ⏳ |
| **Better Stack** (Free) | Log aggregation pino → centralizado | 0€ <1GB/mes | Opcional |
| **Sentry** (Free) | Error tracking en frontends | 0€ <5k events/mes | Opcional |

### Comunicacion ops
| Servicio | Para que | Estado |
|----------|----------|--------|
| **Bot Telegram** | Alertas P0 (pago atascado, breaker open, DB down) | ⏳ script existe, falta token bot |
| **Grupo WhatsApp staff** | Comunicacion managers (no ops) | manual |

### Pasarelas (CRITICAS)
| Pasarela | Estado |
|----------|--------|
| **Wipay** | ⏳ falta firmar contrato + obtener credentials |
| **Peanpe** | ⏳ idem (recomendada como failover) |

### Coolify (opcional, recomendado)
- Self-hosted Heroku-like en el VPS
- Despliega desde GitHub push
- Maneja blue/green deploy + rollback
- Estado: ⏳ instalar en el VPS

---

## 5. Que necesitamos especificamente de Peanpe

Asumimos un API similar al de Wipay porque la documentacion de Peanpe no esta en publico. Hay que confirmar con su account manager:

### Datos tecnicos
1. **URL base produccion + sandbox**
2. **Formato autenticacion**: hoy asumimos `api-key` por header. Confirmar (puede ser HMAC con cada request, OAuth2, etc).
3. **Endpoints exactos**:
   - Crear pago / autorizar: hoy llamamos `POST /payments`
   - Estado pago: hoy `GET /payments/:id`
   - Refund: hoy `POST /payments/:id/refund`
   - Confirmar paths reales y diferencias.
4. **Schema request authorize**: hoy enviamos `{externalRef, amountCents, venueId}`. Confirmar campos requeridos.
5. **Schema response authorize**: hoy esperamos `{id}` como providerTxId. Confirmar.
6. **Schema webhook recibido**: hoy esperamos `{id, type, providerTxId, externalRef, amountCents, ts}`. Crucial.
7. **Algoritmo HMAC webhook**: hoy `HMAC-SHA256(secret, "<ts>.<rawBody>")` en header `x-signature` con `x-timestamp` epoch ms. Confirmar.
8. **Tipos de evento webhook**: hoy mapeamos `payment.authorized`, `payment.failed`, `payment.voided`. Confirmar exactos.
9. **Idempotencia refund**: hoy mandamos `Idempotency-Key: <refund.id>` (UUID). Confirmar header esperado.
10. **Status codes y errores tipados**: que codigos devuelve para "fondos insuficientes", "tarjeta rechazada", "timeout pasarela", etc.

### Datos de negocio
1. **Comision por transaccion** (% + fijo)
2. **Limites**: monto minimo/maximo, TPS por venue
3. **Ventana de refund** (cuantos dias se puede refundear)
4. **Settlement / payout**: cuando llega el dinero a tu cuenta
5. **Soporte**: nivel SLA, canal (email/teleforno/Telegram), horario
6. **IPs origen webhooks** (para whitelist Cloudflare)
7. **Ambiente sandbox**: como pedimos credentials de prueba sin contrato firmado
8. **Process onboarding**: docs KYC requeridos, tiempo estimado activacion

### Casos borde a aclarar
1. Que pasa si nuestro webhook responde 5xx → cuantos reintentos hacen y con que cadencia
2. Pueden mandar el mismo `event_id` mas de una vez (cabe esperar duplicados — ya lo manejamos)
3. Pueden mandar webhooks fuera de orden (`failed` antes de `authorized`)
4. Si un pago se autoriza pero el webhook se pierde, hay endpoint para "recuperarlo" (esto es lo que llamamos orphan-reconcile, hoy llamamos `getStatus(providerTxId)` — confirmar exists)

---

## 6. Setup checklist para entregar a alguien nuevo

Ya existe en [docs/checklists/onboarding-local.md](docs/checklists/onboarding-local.md) y en [SETUP.md](SETUP.md). Ese flow ya funciona — un dev nuevo puede tener el stack arriba en <30min siguiendo `bootstrap.sh`.

Lo que falta para "deploy a prod":
- VPS provisionado con Coolify
- Dominio apuntando a Cloudflare
- Cloudflare → VPS via tunnel o IP directa con WAF
- `.env.production` con todos los secretos rotados
- Credentials Wipay / Peanpe inyectadas via `cli set-credential`
- Backup cron configurado en VPS
- Uptime Robot apuntando a `https://api.tudominio.com/v1/health`

---

## 7. Orden recomendado de proximos pasos

**Semana 1** — sin pasarelas reales todavia
1. Provisionar VPS Hetzner + instalar Coolify
2. Comprar dominio + apuntar a Cloudflare
3. Configurar tunnel Cloudflare → VPS
4. Deploy NightPay a Coolify (con mocks todavia)
5. Validar `/health` desde Internet via dominio
6. Configurar Uptime Robot

**Semana 2** — Wipay sandbox
1. Pedir credentials sandbox a Wipay
2. Reemplazar mock-wipay por endpoint sandbox real
3. Hacer 10-20 pagos de prueba E2E
4. Verificar webhooks reales llegan + se firman correctamente
5. Probar refunds reales
6. Si todo OK → pedir credentials produccion

**Semana 3** — Wipay produccion
1. Firmar contrato + obtener API_KEY produccion
2. `pnpm cli set-credential` para los 6 venues
3. Soft launch con 1 venue (Luna VLC, mas controlable)
4. Monitor Grafana + Uptime Robot 1 semana

**Semana 4+** — escalado
1. Activar segundo venue, luego los demas
2. Pedir credentials Peanpe (sandbox → prod)
3. Implementar auto-failover Wipay ↔ Peanpe
4. Drill restore mensual
5. Game day chaos

---

## 8. Comando "todo arriba" (referencia rapida)

```powershell
cd C:\Users\mehdi\Documents\GitHub\first_tries\nightpay

# 1. Infra
docker compose up -d postgres redis mock-wipay mock-peanpe

# 2. API (deja corriendo)
pnpm --filter "@nightpay/api" dev

# 3. (otra ventana) Frontends
pnpm --filter "@nightpay/admin" dev      # → 4103
pnpm --filter "@nightpay/tpv" dev        # → 4102
pnpm --filter "@nightpay/web-client" dev # → 4101

# 4. Login
# admin: http://localhost:4103
# user:  owner@nightpay.local
# pwd:   nightpay-dev-2026  (rotalo via `pnpm cli reset-password`)

# 5. Tests
pnpm --filter "@nightpay/api" test       # 99 deben pasar
```
