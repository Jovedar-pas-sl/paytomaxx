import { describe, it, expect, vi, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@nightpay/db';
import { PrismaService } from './prisma.service';

/**
 * Lo que PrismaService cuenta al log: los eventos del motor (DI-08) y, al
 * arrancar, si el rol de la base se salta RLS (DI-05: aviso, nunca bloqueo;
 * producción entra hoy como el superusuario `np`).
 */

type Role = { role: string; rolsuper: boolean; rolbypassrls: boolean };

function makeService(queryRaw: () => Promise<unknown>) {
  const metrics = {
    tenantUnscopedQueries: { inc: vi.fn() },
    rlsOutsideTransaction: { inc: vi.fn() },
    dbRoleBypassesRls: { set: vi.fn() },
  };
  const prisma = new PrismaService(new ClsService(new AsyncLocalStorage()) as never, undefined, metrics as never);
  const target = prisma as unknown as Record<string, unknown>;
  target.$use = vi.fn();
  target.$connect = vi.fn(async () => undefined);
  target.$queryRaw = vi.fn(queryRaw);
  return { prisma, metrics, queryRaw: target.$queryRaw as ReturnType<typeof vi.fn> };
}

const warnings = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => String(c[0]));

afterEach(() => vi.restoreAllMocks());

describe('PrismaService: eventos del motor al log (DI-08)', () => {
  it('se engancha a los avisos y errores de Prisma al crearse', () => {
    const on = vi.spyOn(PrismaClient.prototype, '$on');
    makeService(async () => []);
    expect(on.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['warn', 'error']));
  });
});

describe('PrismaService: rol de la base que se salta RLS (DI-05)', () => {
  it('superusuario (np en producción): un aviso claro y la métrica a 1; arranca igual', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, metrics } = makeService(async () => [{ role: 'np', rolsuper: true, rolbypassrls: true } satisfies Role]);
    await expect(prisma.onModuleInit()).resolves.toBeUndefined();
    await prisma.checkDatabaseRole();
    const rls = warnings(warn).filter((w) => /RLS/.test(w));
    expect(rls.length).toBeGreaterThanOrEqual(1);
    expect(rls[0]).toMatch(/«np».*superusuario/);
    expect(metrics.dbRoleBypassesRls.set).toHaveBeenLastCalledWith(1);
  });

  it('BYPASSRLS sin superusuario: también avisa', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, metrics } = makeService(async () => [{ role: 'app', rolsuper: false, rolbypassrls: true } satisfies Role]);
    await prisma.checkDatabaseRole();
    expect(warnings(warn).join('\n')).toMatch(/«app».*BYPASSRLS/);
    expect(metrics.dbRoleBypassesRls.set).toHaveBeenLastCalledWith(1);
  });

  it('un rol sin superusuario ni BYPASSRLS: nada que avisar, métrica a 0', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, metrics } = makeService(async () => [{ role: 'np_app', rolsuper: false, rolbypassrls: false } satisfies Role]);
    await prisma.checkDatabaseRole();
    expect(warnings(warn).filter((w) => /RLS/.test(w))).toEqual([]);
    expect(metrics.dbRoleBypassesRls.set).toHaveBeenLastCalledWith(0);
  });

  it('si no se puede mirar, no rompe nada (ni el arranque)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, metrics } = makeService(async () => {
      throw new Error('permission denied for table pg_roles');
    });
    await expect(prisma.checkDatabaseRole()).resolves.toBeUndefined();
    expect(warnings(warn).join('\n')).toMatch(/No se pudo comprobar el rol/);
    expect(metrics.dbRoleBypassesRls.set).not.toHaveBeenCalled();
  });

  it('el arranque no espera a la comprobación (una consulta colgada no lo para)', async () => {
    const { prisma, queryRaw } = makeService(() => new Promise(() => undefined));
    await expect(prisma.onModuleInit()).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('sin MetricsService (pruebas con base real, CLI): solo el aviso', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = new PrismaService(new ClsService(new AsyncLocalStorage()) as never);
    (prisma as unknown as Record<string, unknown>).$queryRaw = vi.fn(async () => [{ role: 'np', rolsuper: true, rolbypassrls: false }]);
    await prisma.checkDatabaseRole();
    expect(warnings(warn).join('\n')).toMatch(/superusuario/);
  });
});
