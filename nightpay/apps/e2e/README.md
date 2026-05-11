# NightPay E2E

End-to-end tests con Playwright. Cubre:
- **api-smoke.spec.ts** — flujos críticos del API (auth, metrics, treasury, role checks, rate limit).
- **admin-ui.spec.ts** — el dashboard admin renderiza sin crash + cambios de tab.

## Prerequisitos

Todo corriendo en local:
- Postgres + Redis (`docker compose up postgres redis`)
- API (`pnpm --filter @nightpay/api dev`) en :4100
- Admin (`pnpm --filter @nightpay/admin dev`) en :4103
- Seed mínima: `pnpm --filter @nightpay/db cli create-owner --venue luna-vlc --email owner@nightpay.local --password "<pass>"`

## Setup

```bash
pnpm --filter @nightpay/e2e install
pnpm --filter @nightpay/e2e exec playwright install chromium
```

## Variables de entorno

Crea `apps/e2e/.env.local` (gitignored) con:

```bash
E2E_OWNER_SUB=<UUID del owner — SELECT id FROM users WHERE role='OWNER'>
E2E_TENANT_ID=<UUID del venue — SELECT "tenantId" FROM users WHERE role='OWNER'>
E2E_OWNER_EMAIL=owner@nightpay.local
E2E_VENUE_SLUG=luna-vlc
JWT_SECRET=<copia del .env.local del API>
```

Comando rápido para obtener los UUIDs:

```bash
docker exec nightpay_postgres psql -U np -d nightpay -c \
  "SELECT id, \"tenantId\" FROM users WHERE role='OWNER' LIMIT 1;"
```

## Run

```bash
pnpm --filter @nightpay/e2e test            # headless
pnpm --filter @nightpay/e2e test:headed     # ve el browser
pnpm --filter @nightpay/e2e test:ui         # UI interactiva
pnpm --filter @nightpay/e2e report          # abre el HTML report
```

Filtrar:

```bash
pnpm --filter @nightpay/e2e test -- --grep "@api"
pnpm --filter @nightpay/e2e test -- --grep "@admin"
pnpm --filter @nightpay/e2e test -- --grep "@security"
```

## Diseño

- **No login flow real**: minteamos JWTs directamente con el `JWT_SECRET` del API.
  Mucho más rápido y evita acoplar tests a passwords del dev seed.
- **`fullyParallel: false`**: tests pueden tocar el mismo dev DB; serializamos.
- **Sin trace en CI por defecto**: solo en fallos. Reduce tiempo en green builds.
- **Headless por defecto**: usa `test:headed` para depurar visualmente.

## CI

El workflow GitHub Actions (`.github/workflows/e2e.yml` — TODO) debe:
1. Levantar Postgres + Redis vía services.
2. Ejecutar `pnpm --filter @nightpay/db push:dev` para schema.
3. Seedear owner + 1 operadora.
4. Lanzar API + admin en background.
5. `pnpm --filter @nightpay/e2e test`.
