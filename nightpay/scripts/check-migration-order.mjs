#!/usr/bin/env node
// check-migration-order — cada migración NUEVA (que no está en main) tiene que
// ordenarse DESPUÉS de la última migración de main. Y, desde LOCK_TIMEOUT_SINCE,
// toda migración que toma candados (ALTER TABLE, CREATE INDEX, ADD CONSTRAINT…)
// empieza con SET lock_timeout (ver abajo).
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * Las migraciones corren con el API anterior sirviendo (start-first): una que
 * espera un candado detrás de una transacción larga deja en cola todas las
 * escrituras de esa tabla (cobros, saldos) mientras espera. Con
 * SET lock_timeout falla a los pocos segundos y se vuelve a desplegar
 * (docs/DOKPLOY-STEPS.md, D.8). Era solo una costumbre (20261022100000 no lo
 * lleva): desde aquí se exige. Las de antes ya están aplicadas: no se tocan.
 */
export const LOCK_TIMEOUT_SINCE = '20261029000000';

/** Sentencias que toman un candado que bloquea escrituras (no las CONCURRENTLY). */
const LOCKING_DDL =
  /\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)|DROP\s+INDEX(?!\s+CONCURRENTLY)|ADD\s+CONSTRAINT|DROP\s+TABLE|CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER|LOCK\s+TABLE)\b/i;
const SET_LOCK_TIMEOUT = /\bSET\s+(?:LOCAL\s+)?lock_timeout\b/i;

/** El SQL sin comentarios (de línea y de bloque): lo que dicen no cuenta. */
function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** null si cumple; si no, qué le falta. */
export function lockTimeoutProblem(sql) {
  const code = withoutComments(sql);
  const lock = LOCKING_DDL.exec(code);
  if (!lock) return null;
  const set = SET_LOCK_TIMEOUT.exec(code);
  if (!set) return `toma candados (${lock[0]}) y no lleva SET lock_timeout`;
  if (set.index > lock.index) return `SET lock_timeout tiene que ir antes de la primera sentencia con candado (${lock[0]})`;
  return null;
}

/** Las de LOCK_TIMEOUT_SINCE en adelante que no cumplen, con el motivo. */
export function migrationsWithoutLockTimeout(migrations) {
  return migrations
    .filter((m) => m.name > LOCK_TIMEOUT_SINCE)
    .map((m) => ({ name: m.name, problem: lockTimeoutProblem(m.sql) }))
    .filter((m) => m.problem !== null);
}

function migrationSqlInTree(root) {
  const dir = join(root, MIGRATIONS);
  return migrationsInTree(root)
    .filter((name) => existsSync(join(dir, name, 'migration.sql')))
    .map((name) => ({ name, sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8') }));
}

/** Las nuevas que no van después de la última de la base (orden de Prisma: por nombre). */
function misordered(baseNames, headNames) {
  const known = new Set(baseNames);
  const last = [...baseNames].sort().at(-1) ?? '';
  return headNames.filter((n) => !known.has(n) && n <= last).sort();
}

function main() {
  const root = git('rev-parse', '--show-toplevel');
  const noTimeout = migrationsWithoutLockTimeout(migrationSqlInTree(root));
  if (noTimeout.length > 0) {
    console.error(`Migraciones (desde ${LOCK_TIMEOUT_SINCE}) que toman candados sin SET lock_timeout al principio:`);
    for (const m of noTimeout) console.error(`  - ${m.name}: ${m.problem}`);
    console.error(
      "Empiézalas con SET lock_timeout = '5s'; (corren con el API anterior sirviendo: ver docs/DOKPLOY-STEPS.md, D.5).",
    );
    process.exit(1);
  }
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

// Como script (CI); importado (las pruebas), solo las funciones.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
