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

No está en CI, a propósito: estas pruebas necesitan el API **y** las webs
corriendo, un owner y una operadora concretos ya creados (`E2E_OWNER_SUB`,
`E2E_TENANT_ID`), el `JWT_SECRET` del API y además prueban el límite de
peticiones; montado en el job `docker` saldrían intermitentes. Lo que CI sí
cubre: las imágenes arrancan y responden (job `docker`), y los flujos del
dinero contra un Postgres real (job `integracion`,
`apps/api/test/integration/`).

Para lanzarlas antes de un despliegue grande: el apartado *Prerequisitos* de
arriba en local y `pnpm --filter @nightpay/e2e test`.

Los scripts sueltos antiguos (`test-e2e-*.mjs`) están en
[`legacy-scripts/`](legacy-scripts/README.md).
