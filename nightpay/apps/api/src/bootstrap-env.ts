// Carga .env.local desde la raiz del monorepo ANTES de que cualquier modulo lea process.env.
// Importar este archivo PRIMERO en main.ts (antes de NestFactory).
//
// Por que: tsx watch + dotenv-cli en pipe tiene un bug ENOSYS en Windows
// al matar el subproceso. Cargamos dotenv directo y eliminamos el wrapper.
//
// En produccion (Docker / Dokploy) las env vars vienen inyectadas por el orquestrador
// y no existe .env.local — el loop simplemente no encuentra nada y no hace nada.

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const here = __dirname;
// apps/api/src -> 3 levels up = nightpay/
const candidates = [
  resolve(here, '../../../.env.local'),
  resolve(here, '../../.env.local'),
  resolve(here, '../.env.local'),
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), '../../.env.local'),
];

for (const p of candidates) {
  if (existsSync(p)) {
    config({ path: p });
    // eslint-disable-next-line no-console
    console.log(`[env] loaded ${p}`);
    break;
  }
}
