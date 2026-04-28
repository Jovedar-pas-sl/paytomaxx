// Carga .env.local desde la raiz del monorepo ANTES de que cualquier modulo lea process.env.
// Importar este archivo PRIMERO en main.ts (antes de NestFactory).
//
// Por que: tsx watch + dotenv-cli en pipe tiene un bug ENOSYS en Windows
// al matar el subproceso. Cargamos dotenv directo y eliminamos el wrapper.

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveHere(): string {
  // CommonJS — tsx compila a CJS por defecto, __dirname existe
  // Fallback ESM via import.meta si en el futuro pasamos a NodeNext
  if (typeof __dirname !== 'undefined') return __dirname;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — solo se ejecuta en modo ESM
  return dirname(fileURLToPath(import.meta.url));
}

const here = resolveHere();
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
