# Scripts E2E antiguos (a mano)

Pruebas de humo de sprints de mayo de 2026, escritas como scripts sueltos de
Node. Estaban en la raíz de `nightpay/` y nadie las lanzaba: se guardan aquí
como referencia. **No forman parte de CI** y pueden estar desfasadas respecto
al API actual (rutas, permisos, datos de ejemplo).

| Script | Qué probaba |
|---|---|
| `test-e2e-quality-fixes.mjs` | Arreglos de calidad del 2026-05-13 |
| `test-e2e-deferred-fixes.mjs` | Pendientes cerrados el 2026-05-14 (datáfono, etc.) |
| `test-e2e-pos-zones-paytef.mjs` | Zonas de datáfono + Paytef (sprint doble) |
| `test-e2e-paytef-real.mjs` | Paytef REAL con token de producción (¡cobra de verdad!) |
| `test-e2e-refund-accumulator.mjs` | Devoluciones parciales acumuladas |
| `test-e2e-self-onboarding.mjs` | Enlace de alta de la chica de un solo uso |
| `test-e2e-wallet-tip.mjs` | Propina en un consumo del saldo |

Si hace falta alguno:

- Solo contra el entorno **local** (`docker compose up postgres redis` y el
  API en `http://localhost:4100`): leen y escriben la base con
  `docker exec nightpay_postgres psql …`. Nunca contra producción.
- Necesitan usuarios de ejemplo (`owner@nightpay.local`, `ana@local.test`…)
  creados con `pnpm cli` y la contraseña que pide cada script.
- `node apps/e2e/legacy-scripts/<script>.mjs`

Lo que siga teniendo valor debería pasar a las pruebas de verdad: unitarias
en `apps/api/src/**/*.spec.ts`, de integración (Postgres real) en
`apps/api/test/integration/` o de Playwright en `apps/e2e/tests/`.
