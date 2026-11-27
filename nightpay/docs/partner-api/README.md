# API de socios de OxioPay (v1)

Otras plataformas entran en OxioPay con una clave por local (`/v1/partner`). La
primera es la red de cajeros del dueño, que solo carga saldo dentro de los
locales. Apagada de serie (`PARTNER_API_ENABLED=false`) hasta el PR 8.

## Qué hay aquí

| Ruta | Qué es | Quién la escribe |
|---|---|---|
| `pilot/` | El contrato del piloto de los cajeros (YAML, su JSON y las dos guías). **Manda sobre el código.** | A mano (ver `pilot/README.md`) |
| `openapi.json` | El documento OpenAPI 3.1 que sirve `GET /v1/partner/openapi.json`. | Generado: `pnpm --filter @nightpay/api partner:docs` |
| `errors.md` | El catálogo de errores (`code`, estado, título, texto en inglés y en español). | Generado, con el anterior |
| `guides/es/`, `guides/en/` | Las guías por capítulos, mismo número en los dos idiomas. | A mano |

## Reglas

- **Una sola fuente.** Las rutas salen de `packages/contracts/src/partner/routes.ts`
  (`PARTNER_ROUTES`): los controladores solo las declaran con
  `@PartnerRoute(PARTNER_ROUTES.x)`, y lo que sale pasa por el esquema publicado.
  Los errores, de `packages/contracts/src/partner/errors.ts`.
- **Generado = repositorio.** Tras tocar rutas, esquemas o errores:
  `pnpm --filter @nightpay/api partner:docs` y al mismo commit. La prueba
  `apps/api/src/modules/partner/openapi.spec.ts` falla si no.
- **Igual que el contrato.** La misma prueba compara cada ruta hecha con
  `pilot/openapi-piloto.json` (respuestas, esquemas, permisos, parámetros y
  seguridad). Las del contrato que aún no están hechas van en `PILOT_PENDING`.
- **ES/EN a la par.** Cada `guides/es/*.md` lleva en su cabecera `en_sha256`, el
  sha256 de la inglesa que traduce (con saltos de línea LF). Si la inglesa cambia
  y la española no, `apps/api/src/modules/partner/docs.spec.ts` falla.

## Capítulos

| Nº | Español | English |
|---|---|---|
| 0 | [Índice](guides/es/00-indice.md) | [Index](guides/en/00-index.md) |
| 1 | [Empieza: tres llamadas en la demo](guides/es/01-empieza.md) | [Get started: three calls on the demo](guides/en/01-get-started.md) |
| 2 | [Claves y seguridad](guides/es/02-claves-y-seguridad.md) | [Keys and security](guides/en/02-keys-and-security.md) |
| 3 | [Identificar al cliente](guides/es/03-identificar-al-cliente.md) | [Identifying the customer](guides/en/03-identifying-the-customer.md) |
| 4 | [Cargar saldo en un cajero](guides/es/04-cargar-saldo.md) | [Loading balance at an ATM](guides/en/04-loading-balance.md) |
| 5 | [Errores y reintentos](guides/es/05-errores-y-reintentos.md) | [Errors and retries](guides/en/05-errors-and-retries.md) |
| 6 | [Cuadre](guides/es/06-cuadre.md) | [Reconciliation](guides/en/06-reconciliation.md) |
| 7 | [Pruebas en la demo](guides/es/07-pruebas-en-la-demo.md) | [Testing on the demo](guides/en/07-testing-on-the-demo.md) |
| 8 | [Antes de salir](guides/es/08-antes-de-salir.md) | [Before going live](guides/en/08-before-going-live.md) |
