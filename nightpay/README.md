# NightPay

Plataforma de cobro híbrida **QR + NFC** para ocio nocturno (discotecas, festivales, bares).
De 60–120s de checkout a <15s. Sin formularios.

**Estado**: Sprint 1 — scaffold monorepo + stack local + CI. No-producción aún.

## Lectura previa obligatoria

Todo el diseño está en `docs/`:
- [MASTER_PLAN_V2.md](docs/MASTER_PLAN_V2.md) — documento maestro (18 secciones)
- [docs/adr/](docs/adr/) — 5 decisiones arquitectónicas
- [docs/runbooks/](docs/runbooks/) — P0/P1 operativos
- [docs/checklists/onboarding-local.md](docs/checklists/onboarding-local.md)

## Quickstart local

### Requisitos
- Node 20 LTS (ver `.nvmrc`)
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
| Mock Wipay | 4901 | http://localhost:4901 |
| Mock Peanpe | 4902 | http://localhost:4902 |
| MailHog UI | 4825 | http://localhost:4825 |

## Estructura

```
nightpay/
├── apps/
│   ├── api/              # NestJS + Fastify
│   ├── web-client/       # Next.js — cliente móvil (puerto 4101)
│   ├── tpv/              # Next.js — terminal camarero (4102)
│   ├── admin/            # Next.js — panel gestión (4103)
│   ├── mock-wipay/       # Fastify mock pasarela
│   └── mock-peanpe/      # Fastify mock pasarela
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
pnpm db:seed                   # poblar datos demo
pnpm db:studio                 # GUI Prisma Studio

# Checks
pnpm typecheck                 # toda la monorepo
pnpm lint
pnpm test                      # vitest
pnpm build

# Limpiar
pnpm clean
docker compose down -v         # reset completo de volúmenes DB/Redis
```

## Sprint 1 — Criterios de aceptación (del Master Plan §17)

- [x] Monorepo pnpm + Turborepo compilando
- [x] Docker Compose dev (Postgres 16, Redis 7, mocks pasarela)
- [x] CI GitHub Actions (lint, typecheck, build, test)
- [x] Prisma schema inicial + migración + seeds
- [ ] Deploy staging automatizado (Coolify) — pendiente fase infra
- [ ] `docker compose up` funciona + CI verde + staging responde `/health`

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
