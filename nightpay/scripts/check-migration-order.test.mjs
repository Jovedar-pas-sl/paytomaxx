// node --test scripts/check-migration-order.test.mjs
// Las migraciones nuevas que toman candados llevan SET lock_timeout (DI-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_TIMEOUT_SINCE, lockTimeoutProblem, migrationsWithoutLockTimeout } from './check-migration-order.mjs';

const NEW = '20261030120000_algo_nuevo';
const OLD = '20261022100000_datafono_recepcion';

test('una migración nueva con ALTER TABLE sin SET lock_timeout: falla', () => {
  assert.match(lockTimeoutProblem('ALTER TABLE "payments" ADD COLUMN "x" TEXT;'), /lock_timeout/);
});

test('CREATE INDEX y ADD CONSTRAINT también; con SET lock_timeout antes, vale', () => {
  assert.notEqual(lockTimeoutProblem('CREATE UNIQUE INDEX "a" ON "b" ("c");'), null);
  assert.notEqual(lockTimeoutProblem('CREATE INDEX IF NOT EXISTS "a" ON b (c);'), null);
  assert.equal(lockTimeoutProblem("SET lock_timeout = '5s';\nCREATE INDEX \"a\" ON b (c);"), null);
  assert.equal(lockTimeoutProblem("set LOCAL lock_timeout TO '5s';\nALTER TABLE b ADD CONSTRAINT x CHECK (y > 0) NOT VALID;"), null);
});

test('el SET tiene que ir antes del primer candado (después ya no sirve)', () => {
  assert.match(lockTimeoutProblem("ALTER TABLE b ADD COLUMN c INT;\nSET lock_timeout = '5s';"), /antes/);
});

test('un comentario que dice «SET lock_timeout» no cuenta, ni un ALTER en un comentario obliga', () => {
  assert.notEqual(lockTimeoutProblem("-- SET lock_timeout = '5s'\nALTER TABLE b ADD COLUMN c INT;"), null);
  assert.equal(lockTimeoutProblem('-- aquí no hay ALTER TABLE de verdad\nSELECT 1;'), null);
  assert.equal(lockTimeoutProblem('/* CREATE INDEX x ON y (z) */ UPDATE b SET c = 1;'), null);
});

test('CREATE INDEX CONCURRENTLY no bloquea escrituras (y no admite otra sentencia): no se le exige', () => {
  assert.equal(lockTimeoutProblem('CREATE INDEX CONCURRENTLY IF NOT EXISTS "a" ON b (c);'), null);
});

test('solo desde la fecha de corte: las ya aplicadas no se reescriben', () => {
  const bad = 'ALTER TABLE b ADD COLUMN c INT;';
  assert.deepEqual(
    migrationsWithoutLockTimeout([
      { name: OLD, sql: bad },
      { name: NEW, sql: bad },
      { name: '20261030130000_bien', sql: `SET lock_timeout = '5s';\n${bad}` },
    ]).map((m) => m.name),
    [NEW],
  );
  assert.ok(OLD < LOCK_TIMEOUT_SINCE && NEW > LOCK_TIMEOUT_SINCE);
});

test('las migraciones del repositorio cumplen', () => {
  const dir = fileURLToPath(new URL('../packages/db/prisma/migrations', import.meta.url));
  const list = readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, 'migration.sql')))
    .map((name) => ({ name, sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8') }));
  assert.ok(list.length > 50);
  assert.deepEqual(migrationsWithoutLockTimeout(list), []);
});
