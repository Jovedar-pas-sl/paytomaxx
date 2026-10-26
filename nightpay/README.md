# NightPay

Plataforma de cobro híbrida **QR + NFC** para ocio nocturno (discotecas, festivales, bares).
De 60–120s de checkout a <15s. Sin formularios.

**Estado (octubre 2026)**: en producción como **OxioPay** en Dokploy, cobrando con Redsys
(TPV de BBVA) — QR con Apple/Google Pay, saldo del cliente con Face ID / PIN / ficha NFC,
datáfonos PAX de Paytef, cuadre con el banco e incidencias por Telegram. Despliegue:
[docs/DOKPLOY-STEPS.md](docs/DOKPLOY-STEPS.md) · copias: [docs/BACKUPS.md](docs/BACKUPS.md) ·
qué hacer si algo falla: [docs/runbooks/](docs/runbooks/). `STATUS.md` es una foto de abril.

## Lectura previa obligatoria

Todo el diseño está en `docs/`:
- [MASTER_PLAN_V2.md](docs/MASTER_PLAN_V2.md) — documento maestro (18 secciones)
- [docs/adr/](docs/adr/) — 5 decisiones arquitectónicas
- [docs/runbooks/](docs/runbooks/) — P0/P1 operativos (y [VPS perdido](docs/runbooks/P0-vps-perdido.md))
- [docs/checklists/onboarding-local.md](docs/checklists/onboarding-local.md)

## Quickstart local

### Requisitos
- Node 22 LTS (ver `.nvmrc`)
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- Docker + Docker Compose
- ~4GB RAM libre

### Primera vez

```bash
cd nightpay
./scripts/bootstrap.sh    # crea .env.local, levanta DB+Redis, migra, siembra
pnpm dev                  # arranca api + 3 frontends
```

Verificación:

```bash
curl http://localhost:4100/v1/health
# { "status": "ok", "version": "...", "checks": { ... } }
```

### Servicios y puertos

| Servicio | Puerto | URL |
|----------|-------:|-----|
| Postgres 16 | 4432 | `postgresql://np:np@localhost:4432/nightpay` |
| Redis 7 | 4379 | `redis://localhost:4379` |
| API NestJS | 4100 | http://localhost:4100 |
| Web Cliente (Next.js) | 4101 | http://localhost:4101 |
| TPV (Next.js) | 4102 | http://localhost:4102 |
| Admin (Next.js) | 4103 | http://localhost:4103 |
| Operator (Next.js) | 4104 | http://localhost:4104 |
| Simulador Wipay (solo dev; ya no cierra cobros, ver SETUP.md) | 4901 | http://localhost:4901 |
| Simulador Peanpe (solo dev) | 4902 | http://localhost:4902 |
| Mailpit (correo de pruebas) | 4825 | http://localhost:4825 |

## Estructura

```
nightpay/
├── apps/
│   ├── api/              # NestJS + Fastify
│   ├── web-client/       # Next.js — cliente móvil (puerto 4101)
│   ├── tpv/              # Next.js — terminal camarero (4102)
│   ├── admin/            # Next.js — panel gestión (4103)
│   ├── operator/         # Next.js — app de la chica / encargado (4104)
│   ├── pax-android/      # App Android del datáfono PAX
│   ├── e2e/              # Playwright (a mano; ver su README)
│   ├── mock-wipay/       # Simulador de pasarela — SOLO desarrollo, nunca en producción
│   └── mock-peanpe/      # Simulador de pasarela — SOLO desarrollo, nunca en producción
├── packages/
│   ├── contracts/        # Zod schemas compartidos
│   ├── db/               # Prisma schema + cliente
│   └── config/           # tsconfig bases compartidos
├── docs/                 # Master plan + ADRs + runbooks
├── scripts/              # bootstrap, chaos, carga
├── docker-compose.yml
└── turbo.json
```

## Comandos frecuentes

```bash
# Desarrollo
pnpm dev                                # todo en paralelo (turbo)
pnpm --filter @nightpay/api dev         # solo API
pnpm --filter @nightpay/web-client dev  # solo web cliente

# Base de datos
pnpm db:migrate                # aplicar migraciones
pnpm db:seed                   # poblar datos demo (solo crea lo que falta; ver SETUP.md)
pnpm db:studio                 # GUI Prisma Studio

# Checks
pnpm typecheck                 # toda la monorepo
pnpm lint
pnpm test                      # vitest
pnpm --filter @nightpay/api test:integration   # contra Postgres real (apps/api/test/integration)
pnpm build

# Limpiar
pnpm clean
docker compose down -v         # reset completo de volúmenes DB/Redis
```

## Estado por Sprint

- [x] **Sprint 1**: Scaffold monorepo + Docker Compose + CI verde
- [x] **Sprint 2**: Auth + multi-tenancy + Postgres RLS
- [x] **Sprint 3-4**: Payment FSM (XState) + adapter pasarelas + saga compensacion
- [x] **Sprint 5**: Socket.io con Redis adapter + UIs cliente movil + TPV
- [x] **Sprint 6**: Admin dashboard + refunds + reconciliacion diaria
- [x] **Sprint 7**: Hardening seguridad (Helmet, rate-limit, CORS, lockout, ProblemDetails)
- [x] **Sprint 8**: Audit log + Prometheus metrics + Redis lockout + CLI ops
- [x] **Sprint 8.5**: Refresh tokens con rotacion, kill-switch, observability completa
- [x] **Oct 2026**: Redsys/BBVA en producción, saldo del cliente, datáfonos PAX, cuadre con el banco, incidencias

## Endpoints expuestos (`/v1`)

| Metodo | Path | Acceso | Descripcion |
|--------|------|--------|-------------|
| GET  | `/health`                                   | publico | API + base + Redis (503 si falla algo) |
| GET  | `/health/live`                              | publico | Solo «el proceso responde» (healthcheck Docker) |
| GET  | `/metrics`                                  | red interna o `METRICS_TOKEN` | Prometheus exposition |
| POST | `/auth/login`                               | publico | Email + password → access (1 h) + refresh (cookie HttpOnly) |
| POST | `/auth/refresh`                             | publico | Rotar refresh → nuevo access |
| POST | `/auth/logout`                              | publico (cookie) | Cierra la sesión: revoca el refresh y corta su token de acceso al momento |
| POST | `/payments`                                 | auth    | TPV crea pago (idempotency-key required) |
| GET  | `/payments/:id`                             | auth    | Detalle pago |
| GET  | `/payments/public/:token`                   | publico | Cliente escanea QR |
| POST | `/payments/public/:token/start-authorization` | publico | Cliente confirma pago |
| GET  | `/payments/:id/refunds`                     | auth    | Lista refunds |
| POST | `/payments/:id/refunds`                     | auth    | OWNER/MANAGER (TOTP ≥100€) |
| POST | `/webhooks/:provider`                       | publico | HMAC signed (Wipay/Peanpe) |
| GET  | `/venues/me` `/venues/me/terminals` `/venues/me/staff` | auth | Datos del venue |
| GET  | `/admin/payments` `/admin/metrics`          | OWNER/MANAGER | Panel admin |
| POST | `/admin/users/:userId/revoke-sessions`      | OWNER   | Kill-switch movil perdido: refresh, token de acceso y tiempo real, al momento |

## Principios

Ver [docs/MASTER_PLAN_V2.md §3.4](docs/MASTER_PLAN_V2.md) — principios arquitectónicos innegociables:
1. Monolito modular
2. Multi-tenant con `tenant_id` + RLS
3. Event sourcing localizado en `payment_events`
4. Idempotencia por diseño
5. Dinero en céntimos (`Int`) siempre
6. Adapter pattern obligatorio para pasarelas
7. Socket.io con Redis adapter desde día 1
8. Cloudflare al frente

## Licencia

Proprietary — NightPay.
