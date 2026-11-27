// Escribe la documentación generada de la API de socios:
//   docs/partner-api/openapi.json   (la tabla de rutas y los esquemas zod: contracts/partner)
//   docs/partner-api/errors.md      (el catálogo de errores, en inglés y en español)
// Uso: pnpm --filter @nightpay/api partner:docs. La prueba openapi.spec.ts
// falla si lo del repositorio no es lo que se genera.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPartnerOpenApi, partnerErrorsMarkdown } from '@nightpay/contracts';

const DOCS = join(__dirname, '..', '..', '..', 'docs', 'partner-api');
mkdirSync(DOCS, { recursive: true });
writeFileSync(join(DOCS, 'openapi.json'), `${JSON.stringify(buildPartnerOpenApi(), null, 2)}\n`);
writeFileSync(join(DOCS, 'errors.md'), partnerErrorsMarkdown());
console.log(`[partner:docs] ${join(DOCS, 'openapi.json')} y errors.md al día`);
