# Contrato del piloto de los cajeros

Contrato del piloto de los cajeros (26-nov-2026). Manda sobre el código. Si cambia el YAML, se regenera el JSON en el mismo commit.

| Fichero | Qué es |
|---|---|
| `openapi-piloto.yaml` | El contrato (OpenAPI 3.1, en inglés). |
| `openapi-piloto.json` | El mismo contrato en JSON: lo leen las pruebas (`apps/api/src/modules/partner/openapi.spec.ts`). |
| `guia-es.md`, `guide-en.md` | Las guías del piloto para quien programa la plataforma de cajeros. |

Regenerar el JSON (desde esta carpeta, con el js-yaml 4.1.1 que ya trae el repositorio):

```bash
node ../../../node_modules/.pnpm/js-yaml@4.1.1/node_modules/js-yaml/bin/js-yaml.js openapi-piloto.yaml > openapi-piloto.json
```

O, con red: `pnpm dlx js-yaml@4.1.1 openapi-piloto.yaml > openapi-piloto.json`.
