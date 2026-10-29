// Integración (Postgres real): las políticas de RLS calculan el local y el bypass UNA vez por consulta
// (migración 20261101090000_rls_politicas_una_vez). Ver docs/DB-ROLE.md («Velocidad con RLS»).
import { describe, it, expect, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);

afterAll(async () => {
  await prisma.$disconnect();
});

const MIGRATIONS = join(__dirname, '../../../../packages/db/prisma/migrations');
const FIX = '20261101090000_rls_politicas_una_vez';
const RLS_FN = /app_(current_tenant|rls_bypass)\(\)/;
/** Quita las llamadas ya envueltas en un SELECT: lo que quede es una llamada fila a fila. */
const unwrapped = (expr: string | null) => expr !== null && RLS_FN.test(expr.replace(/SELECT\s+(public\.)?app_(current_tenant|rls_bypass)\(\)/gi, ''));

function runMigration(): void {
  const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
  const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', join(MIGRATIONS, FIX, 'migration.sql')], {
    encoding: 'utf8',
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
}

describe('políticas de RLS (una vez por consulta)', () => {
  it('las migraciones de después escriben sus políticas con (SELECT app_current_tenant()) y (SELECT app_rls_bypass())', () => {
    // Las de antes las arregla FIX; una nueva escrita como antes («"tenantId" = app_current_tenant()») sale aquí.
    const later = readdirSync(MIGRATIONS).filter((d) => d > FIX && !d.includes('.'));
    const slow = later.filter((d) => {
      const sql = readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');
      const policies = sql.match(/(CREATE|ALTER)\s+POLICY[\s\S]*?;/gi) ?? [];
      return policies.some((p) => unwrapped(p));
    });
    expect(slow).toEqual([]);
  });

  it('la migración envuelve todas las políticas, se puede repetir y el plan calcula el local una vez (InitPlan)', async () => {
    // Otras pruebas repiten migraciones antiguas (que recrean sus políticas como antes): se aplica aquí, dos veces.
    runMigration();
    runMigration();
    const policies = await prisma.$queryRaw<Array<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>>`
      SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'
    `;
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.filter((p) => unwrapped(p.qual) || unwrapped(p.with_check)).map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
    const plan = await cls.run(() =>
      prisma.withTenant(randomUUID(), (tx) =>
        tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': unknown }>>(`EXPLAIN (FORMAT JSON) SELECT count(*) FROM wallet_consumptions`),
      ),
    );
    expect(JSON.stringify(plan)).toContain('InitPlan');
  }, 120_000);
});
