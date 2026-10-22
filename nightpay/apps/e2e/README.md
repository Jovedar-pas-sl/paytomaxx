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

Las de arriba (`tests/*.spec.ts`, `playwright.config.ts`) siguen fuera de CI:
necesitan un owner y una operadora concretos ya creados, el `JWT_SECRET` del
API para fabricar tokens y prueban el límite de peticiones.

En CI (job `e2e` de `.github/workflows/nightpay-ci.yml`) va otro conjunto,
`tests/ci/` con `playwright.ci.config.ts`, sin tokens fabricados ni refrescos
simulados:

1. Postgres y Redis propios del job; base `nightpay_e2e` con un rol sin
   superusuario, migrada como al arrancar el API (`db-heal` → `prisma migrate
   deploy` → `db-heal`).
2. `fixtures/ci-seed.mjs`: un local, un dueño, un camarero y un saldo con
   passkey. Se niega si no hay `E2E_ISOLATED=1` o la base no es local y se
   llama `nightpay_e2e`.
3. Playwright levanta el API (:4300), el panel (:4303) y la app del personal
   (:4301) y prueba: login de verdad con cookie HttpOnly, la carta de
   referencia aplicada dos veces a la vez (una sola vez) y repetible, la cuenta
   de 50 € en la app (con la invitación ofrecida antes de la copa) y que las
   rutas privadas del saldo no se leen sin desbloquear.

Sin reintentos: cada job empieza de cero y las pruebas cambian datos, así que
un fallo no se tapa repitiendo. Traza y capturas quedan en el artefacto
`navegador-e2e`.

En local, con Docker (puertos libres 4300, 4301 y 4303):

```bash
docker run -d --rm --name e2e-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54399:5432 postgres:16-alpine
docker run -d --rm --name e2e-redis -p 127.0.0.1:63799:6379 redis:7-alpine
docker exec e2e-pg psql -U postgres -c "CREATE ROLE np_app LOGIN PASSWORD 'np_app' NOSUPERUSER" -c "CREATE DATABASE nightpay_e2e OWNER np_app"
export DATABASE_URL=postgresql://np_app:np_app@127.0.0.1:54399/nightpay_e2e REDIS_URL=redis://127.0.0.1:63799 E2E_ISOLATED=1   JWT_SECRET=isolated-e2e-jwt-secret-at-least-32-characters COOKIE_SECRET=isolated-e2e-cookie-secret-at-least-32-characters   ENCRYPTION_KEK=Y2ktdW5hLWNsYXZlLWRlLTMyLWJ5dGVzLXBhcmEtcHJ1ZWJh
(cd packages/db && ./node_modules/.bin/tsx scripts/db-heal.ts && ./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx scripts/db-heal.ts)
pnpm --filter @nightpay/api exec node --import tsx ../e2e/fixtures/ci-seed.mjs
pnpm --filter @nightpay/e2e exec playwright test --config playwright.ci.config.ts
```

Las comprobaciones físicas (teléfonos, fichas NFC, Face ID, PAX) no están aquí.

Los scripts sueltos antiguos (`test-e2e-*.mjs`) están en
[`legacy-scripts/`](legacy-scripts/README.md).
