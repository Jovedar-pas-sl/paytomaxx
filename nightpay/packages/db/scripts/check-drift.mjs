#!/usr/bin/env node
// check-drift — ¿las migraciones dejan la base igual que schema.prisma?
//
// Aplica prisma/migrations en un Postgres VACÍO (base "sombra": Prisma la vacía
// antes) y lo compara con schema.prisma. Lo lanza CI en cada cambio; falla si
// alguien toca schema.prisma sin migración (o al revés).
//
//   node scripts/check-drift.mjs --shadow-database-url postgresql://…/sombra
//
// Para mirar una base de verdad (solo lee, no cambia nada):
//
//   node scripts/check-drift.mjs --from-url "$DATABASE_URL"
//
// Lo que la base tiene a propósito y schema.prisma no describe está en
// drift-allowlist.json, cada cosa con su porqué. Cualquier otra diferencia →
// exit 1 y se imprime el SQL que la explicaría.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const require = createRequire(join(pkg, 'package.json'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const shadow = arg('--shadow-database-url') ?? process.env.SHADOW_DATABASE_URL;
const fromUrl = arg('--from-url');
// Otro schema.prisma (para probar el propio script); por defecto, el del paquete.
const schema = arg('--schema') ?? join(pkg, 'prisma', 'schema.prisma');
if (!shadow && !fromUrl) {
  console.error('uso: check-drift.mjs --shadow-database-url <postgres vacío> | --from-url <base a comparar>');
  process.exit(1);
}

const from = fromUrl
  ? ['--from-url', fromUrl]
  : ['--from-migrations', join(pkg, 'prisma', 'migrations'), '--shadow-database-url', shadow];

const res = spawnSync(
  process.execPath,
  [
    require.resolve('prisma/build/index.js'),
    'migrate',
    'diff',
    ...from,
    '--to-schema-datamodel',
    schema,
    '--script',
    '--exit-code',
  ],
  { encoding: 'utf8', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } },
);
// --exit-code: 0 = sin diferencias, 2 = hay diferencias, otro = error.
if (res.status !== 0 && res.status !== 2) {
  console.error(res.stderr || res.stdout || res.error?.message);
  console.error(`[check-drift] prisma migrate diff falló (código ${res.status})`);
  process.exit(1);
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const statements = res.stdout
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*(?:\n|$)/)
  .map(norm)
  .filter(Boolean)
  .map((s) => `${s};`);

const allow = JSON.parse(readFileSync(join(here, 'drift-allowlist.json'), 'utf8')).statements;
const allowed = new Set(allow.map((a) => norm(a.sql)));

const unexpected = statements.filter((s) => !allowed.has(s));
const present = new Set(statements);
const stale = allow.filter((a) => !present.has(norm(a.sql)));

const what = fromUrl ? 'la base' : 'las migraciones';
console.log(
  `[check-drift] ${what} vs schema.prisma: ${statements.length} diferencia(s), ` +
    `${statements.length - unexpected.length} aceptada(s) en drift-allowlist.json`,
);
for (const a of stale) {
  console.warn(`[check-drift] aviso: ya no hace falta en drift-allowlist.json: ${a.sql}`);
}
if (unexpected.length > 0) {
  console.error(`\n[check-drift] DIFERENCIAS SIN MIGRACIÓN (${unexpected.length}):\n`);
  for (const s of unexpected) console.error(`  ${s}`);
  console.error(
    '\nSi cambiaste schema.prisma: crea la migración (prisma migrate dev --create-only) y revísala.' +
      '\nSi la diferencia es a propósito: añádela a packages/db/scripts/drift-allowlist.json con su porqué.',
  );
  process.exit(1);
}
console.log('[check-drift] OK');
