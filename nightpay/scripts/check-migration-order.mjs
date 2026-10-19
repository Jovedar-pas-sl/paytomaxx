#!/usr/bin/env node
// check-migration-order — cada migración NUEVA (que no está en main) tiene que
// ordenarse DESPUÉS de la última migración de main.
//
// Prisma aplica las migraciones por orden de nombre. Una con fecha anterior a
// la última de main (p. ej. creada con `prisma migrate dev` antes de que
// llegara a la rama una con fecha futura) se aplicaría en producción DESPUÉS de
// las que ya tiene, pero en una base nueva (CI, restaurar en un servidor nuevo)
// ANTES: el orden divergiría.
//
// Uso (CI, job «migraciones-orden», con el historial completo):
//   node scripts/check-migration-order.mjs [--base <ref>]
// Base: git merge-base HEAD origin/main; en main mismo (HEAD = origin/main), el
// commit anterior (HEAD^1). Sale con 1 y la lista si alguna está fuera de orden.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'nightpay/packages/db/prisma/migrations';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function baseRef(argv) {
  const i = argv.indexOf('--base');
  if (i !== -1 && argv[i + 1]) return git('rev-parse', argv[i + 1]);
  const head = git('rev-parse', 'HEAD');
  const base = git('merge-base', 'HEAD', 'origin/main');
  if (base !== head) return base;
  // En main: lo que trae este push/merge frente al main de antes.
  try {
    return git('rev-parse', 'HEAD^1');
  } catch {
    return null; // primer commit: no hay con qué comparar
  }
}

/** Carpetas de migraciones (no migration_lock.toml) en un commit. */
function migrationsAt(ref) {
  const out = git('ls-tree', '--full-tree', '--name-only', `${ref}:${MIGRATIONS}`);
  return out.split('\n').filter((n) => n && !n.includes('.'));
}

function migrationsInTree(root) {
  const dir = join(root, MIGRATIONS);
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
}

/** Las nuevas que no van después de la última de la base (orden de Prisma: por nombre). */
function misordered(baseNames, headNames) {
  const known = new Set(baseNames);
  const last = [...baseNames].sort().at(-1) ?? '';
  return headNames.filter((n) => !known.has(n) && n <= last).sort();
}

function main() {
  const root = git('rev-parse', '--show-toplevel');
  const base = baseRef(process.argv.slice(2));
  if (!base) {
    console.log('check-migration-order: sin commit base con el que comparar; nada que comprobar');
    return;
  }
  const baseNames = migrationsAt(base);
  const headNames = migrationsInTree(root);
  const fresh = headNames.filter((n) => !baseNames.includes(n));
  const bad = misordered(baseNames, headNames);
  const last = [...baseNames].sort().at(-1);
  if (bad.length > 0) {
    console.error(`Migraciones nuevas que se ordenan antes de la última de main (${last}):`);
    for (const name of bad) console.error(`  - ${name}`);
    console.error(
      'Renómbralas con una fecha posterior (carpeta y, si lo hay, cualquier referencia) para que todas las bases las apliquen en el mismo orden.',
    );
    process.exit(1);
  }
  console.log(
    `check-migration-order: ${fresh.length} migración(es) nueva(s) frente a ${base.slice(0, 7)}, todas después de ${last}`,
  );
}

main();
