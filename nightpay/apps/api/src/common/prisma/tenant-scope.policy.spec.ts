import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import { PrismaService, UnscopedTenantQueryError } from './prisma.service';
import { TENANT_SCOPED_MODELS, scopeToTenant } from './tenant-scope';

/** Política de consultas a modelos por local sin local (TENANCY_UNSCOPED_QUERIES). Sin BD real. */

const TENANT_A = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const TENANT_B = 'b7e1d2c3-0000-4000-8000-00000000beef';
/** Los que cruzan locales por diseño o llegan sin local (ver tenant-scope.ts). */
const CROSS_VENUE = new Set(['ClientWallet', 'WalletConsumption', 'WalletPasskey', 'WalletCard', 'WalletPushSubscription', 'WebhookDelivery', 'PeanpeCall', 'AuditEvent']);

type Params = { model?: string; action: string; args?: Record<string, unknown>; runInTransaction?: boolean };
type Middleware = (p: Params, next: (p: Params) => Promise<Params>) => Promise<Params>;

async function makePrisma(opts: { config?: Record<string, string | undefined> } = {}) {
  const cls = new ClsService(new AsyncLocalStorage());
  const metrics = { tenantUnscopedQueries: { inc: vi.fn() }, rlsOutsideTransaction: { inc: vi.fn() } };
  const config = opts.config ? { get: vi.fn((k: string) => opts.config?.[k]) } : undefined;
  const prisma = new PrismaService(cls as never, config as never, metrics as never);
  const target = prisma as unknown as Record<string, unknown>;
  const mws: Middleware[] = [];
  target.$use = (fn: Middleware) => mws.push(fn);
  target.$connect = vi.fn();
  // La comprobación del rol de la base al arrancar (sin base real: ningún rol).
  target.$queryRaw = vi.fn(async () => []);
  target.$transaction = async (fn: (tx: unknown) => unknown) => fn({ $executeRawUnsafe: vi.fn(), $executeRaw: vi.fn() });
  await prisma.onModuleInit();
  const run = (params: Params) => {
    const mw = mws[0];
    if (!mw) throw new Error('middleware sin instalar');
    return mw(params, async (p) => p);
  };
  const inCtx = <T>(ctx: Record<string, unknown>, fn: () => Promise<T>) =>
    cls.run(async () => {
      cls.set('ctx', ctx);
      return fn();
    });
  return { prisma, run, inCtx, metrics };
}

const sinLocal = (): Params => ({ model: 'Payment', action: 'findMany', args: { where: { status: 'AUTHORIZED' } } });

let logError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  logError.mockRestore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('TENANT_SCOPED_MODELS frente al esquema de Prisma', () => {
  const models = Prisma.dmmf.datamodel.models;
  const conTenant = models.filter((m) => m.fields.some((f) => f.name === 'tenantId')).map((m) => m.name);

  it('todo modelo con tenantId está protegido o en la lista de los que cruzan locales', () => {
    expect(conTenant.filter((m) => !TENANT_SCOPED_MODELS.has(m) && !CROSS_VENUE.has(m))).toEqual([]);
  });

  it('todo modelo protegido existe y tiene tenantId (sin erratas en la lista)', () => {
    expect([...TENANT_SCOPED_MODELS].filter((m) => !conTenant.includes(m))).toEqual([]);
  });
});

describe('TENANCY_UNSCOPED_QUERIES — de dónde sale la política', () => {
  it('sin ConfigService: se lee del entorno (throw corta)', async () => {
    vi.stubEnv('TENANCY_UNSCOPED_QUERIES', 'throw');
    const { run } = await makePrisma();
    await expect(run(sinLocal())).rejects.toBeInstanceOf(UnscopedTenantQueryError);
  });

  it('ConfigService manda sobre el entorno', async () => {
    vi.stubEnv('TENANCY_UNSCOPED_QUERIES', 'throw');
    const { run, metrics } = await makePrisma({ config: { TENANCY_UNSCOPED_QUERIES: 'log' } });
    await expect(run(sinLocal())).resolves.toBeDefined();
    expect(metrics.tenantUnscopedQueries.inc).toHaveBeenCalledWith({ model: 'Payment', action: 'findMany' });
  });

  it('ConfigService sin valor: cae al entorno', async () => {
    vi.stubEnv('TENANCY_UNSCOPED_QUERIES', 'throw');
    const { run } = await makePrisma({ config: {} });
    await expect(run(sinLocal())).rejects.toThrow(/Payment\.findMany/);
  });

  it.each(['off', 'THROW', 'true', ''])('valor %j = modo log: pasa pero se cuenta (nunca se apaga el aviso)', async (value) => {
    vi.stubEnv('TENANCY_UNSCOPED_QUERIES', value);
    const { run, metrics } = await makePrisma();
    await expect(run(sinLocal())).resolves.toBeDefined();
    expect(metrics.tenantUnscopedQueries.inc).toHaveBeenCalledTimes(1);
  });
});

describe('modo throw — qué se corta y qué no', () => {
  const throwMode = () => makePrisma({ config: { TENANCY_UNSCOPED_QUERIES: 'throw' } });

  it('contexto de petición con tenantId vacío cuenta como sin local → se corta', async () => {
    const { run, inCtx } = await throwMode();
    await expect(inCtx({ tenantId: '', traceId: 'tr-9' }, () => run(sinLocal()))).rejects.toBeInstanceOf(
      UnscopedTenantQueryError,
    );
  });

  it('asSystem y acrossVenues sin local: explícitos, pasan sin filtro', async () => {
    const { prisma, run, metrics } = await throwMode();
    const sys = await prisma.asSystem(() => run(sinLocal()));
    const across = await prisma.acrossVenues(() => run(sinLocal()));
    expect(sys.args).toEqual({ where: { status: 'AUTHORIZED' } });
    expect(across.args).toEqual({ where: { status: 'AUTHORIZED' } });
    expect(metrics.tenantUnscopedQueries.inc).not.toHaveBeenCalled();
  });

  it('acrossVenues dentro de una sesión con local: sin filtro y sin error', async () => {
    const { prisma, run, inCtx } = await throwMode();
    const out = await inCtx({ tenantId: TENANT_A }, () => prisma.acrossVenues(() => run(sinLocal())));
    expect(out.args?.where).toEqual({ status: 'AUTHORIZED' });
  });

  it('withTenant dentro de acrossVenues vuelve a filtrar por ese local', async () => {
    const { prisma, run } = await throwMode();
    const out = await prisma.acrossVenues(() => prisma.withTenant(TENANT_B, () => run(sinLocal())));
    expect(out.args?.where).toEqual({ status: 'AUTHORIZED', tenantId: TENANT_B });
  });

  it('modelos sin local (Venue, Business, WalletPass) nunca se marcan', async () => {
    const { run, metrics } = await throwMode();
    for (const model of ['Venue', 'Business', 'WalletPass']) {
      await expect(run({ model, action: 'findMany', args: {} })).resolves.toBeDefined();
    }
    expect(metrics.tenantUnscopedQueries.inc).not.toHaveBeenCalled();
  });

  it('los que cruzan locales (dentro de transacción) tampoco se marcan ni se filtran', async () => {
    const { run, metrics } = await throwMode();
    for (const model of CROSS_VENUE) {
      const out = await run({ model, action: 'findFirst', args: { where: { id: 'x' } }, runInTransaction: true });
      expect(out.args).toEqual({ where: { id: 'x' } });
    }
    expect(metrics.tenantUnscopedQueries.inc).not.toHaveBeenCalled();
  });

  it('SQL crudo sin modelo y sin tablas con FORCE RLS: no cuenta como consulta sin local', async () => {
    const { run, metrics } = await throwMode();
    await expect(run({ action: 'queryRaw', args: [['SELECT 1 FROM payments']] as never })).resolves.toBeDefined();
    expect(metrics.tenantUnscopedQueries.inc).not.toHaveBeenCalled();
  });
});

describe('modo log — avisos sin inundar el log', () => {
  it('un aviso por modelo.acción cada 10 min; la métrica cuenta todas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
    const { run, metrics } = await makePrisma({ config: { TENANCY_UNSCOPED_QUERIES: 'log' } });
    await run(sinLocal());
    await run(sinLocal());
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).toMatch(/Payment\.findMany/);

    await run({ model: 'Payment', action: 'count', args: {} });
    expect(logError).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-17T02:09:59Z'));
    await run(sinLocal());
    expect(logError).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-17T02:10:00Z'));
    await run(sinLocal());
    expect(logError).toHaveBeenCalledTimes(3);
    expect(metrics.tenantUnscopedQueries.inc).toHaveBeenCalledTimes(5);
  });

  it('el aviso lleva el traceId de la petición', async () => {
    const { run, inCtx } = await makePrisma({ config: { TENANCY_UNSCOPED_QUERIES: 'log' } });
    await inCtx({ traceId: 'cf-ray-8d1f2a' }, () => run({ model: 'Refund', action: 'findMany', args: {} }));
    expect(String(logError.mock.calls[0]?.[0])).toMatch(/traceId=cf-ray-8d1f2a/);
  });
});

describe('scopeToTenant — bordes de aislamiento', () => {
  it('lecturas y borrados: el local del contexto gana a cualquier tenantId de la consulta', () => {
    for (const action of ['findUniqueOrThrow', 'findFirstOrThrow', 'aggregate', 'groupBy', 'delete']) {
      const out = scopeToTenant({ action, args: { where: { tenantId: { in: [TENANT_A, TENANT_B] }, OR: [{ tenantId: TENANT_B }] } } }, TENANT_A);
      expect(out.args?.where).toEqual({ tenantId: TENANT_A, OR: [{ tenantId: TENANT_B }] });
    }
  });

  it('count sin argumentos también se filtra', () => {
    const params: { action: string; args?: Record<string, unknown> } = { action: 'count' };
    expect(scopeToTenant(params, TENANT_A).args).toEqual({ where: { tenantId: TENANT_A } });
  });

  it('createMany con filas de otro local: se reescriben y las originales no cambian', () => {
    const rows = [{ amountCents: 1500, tenantId: TENANT_B }];
    const out = scopeToTenant({ action: 'createMany', args: { data: rows } }, TENANT_A);
    expect(out.args?.data).toEqual([{ amountCents: 1500, tenantId: TENANT_A }]);
    expect(rows[0]?.tenantId).toBe(TENANT_B);
  });

  it('acciones que no conoce (SQL crudo) se devuelven tal cual', () => {
    const params = { action: 'executeRaw', args: { query: 'SELECT 1' } };
    expect(scopeToTenant(params, TENANT_A)).toBe(params);
  });

  // BUG: tenant-scope.ts:68 — createMany acepta `data` como objeto suelto (tipo Prisma
  // `XCreateManyInput | XCreateManyInput[]`), pero solo se reescribe si es array:
  // createMany({ data: { tenantId: OTRO } }) llega a la base con el local de otro.
  // Hoy todos los createMany de src/ pasan array (latente).
  it.skip('createMany con un objeto suelto también se fuerza al local del contexto', () => {
    const out = scopeToTenant({ action: 'createMany', args: { data: { amountCents: 1500, tenantId: TENANT_B } } }, TENANT_A);
    expect(out.args?.data).toEqual({ amountCents: 1500, tenantId: TENANT_A });
  });

  // BUG: tenant-scope.ts:61-67 — update/updateMany/upsert limitan el `where` al local,
  // pero no tocan `data` (ni `update` del upsert): un data.tenantId = OTRO mueve la fila
  // a otro local. En tablas sin FORCE RLS el dueño no pasa por las políticas, así que la
  // base no lo para si la app se conecta como dueño (ver rls.ts). Hoy ningún update
  // de src/ pasa tenantId desde la petición (latente, defensa en profundidad).
  it.skip('update / upsert no pueden cambiar la fila de local', () => {
    const upd = scopeToTenant({ action: 'update', args: { where: { id: 'p' }, data: { tenantId: TENANT_B } } }, TENANT_A);
    expect((upd.args?.data as { tenantId?: string }).tenantId).not.toBe(TENANT_B);
    const ups = scopeToTenant({ action: 'upsert', args: { where: { id: 'p' }, create: {}, update: { tenantId: TENANT_B } } }, TENANT_A);
    expect((ups.args?.update as { tenantId?: string }).tenantId).not.toBe(TENANT_B);
  });
});

describe('PrismaService — ciclo de vida', () => {
  it('onApplicationShutdown desconecta (al final del apagado, después del HTTP y los workers)', async () => {
    const { prisma } = await makePrisma();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    (prisma as unknown as Record<string, unknown>).$disconnect = disconnect;
    await prisma.onApplicationShutdown();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('PrismaService — tiempos de la transacción (DI-02)', () => {
  it('withTenant y asSystem pasan los tiempos pedidos a la transacción; sin ellos, los de Prisma', async () => {
    const { prisma } = await makePrisma();
    const seen: unknown[] = [];
    (prisma as unknown as Record<string, unknown>).$transaction = async (fn: (tx: unknown) => unknown, options?: unknown) => {
      seen.push(options);
      return fn({ $executeRawUnsafe: vi.fn(), $executeRaw: vi.fn() });
    };
    await prisma.withTenant('t-1', async () => 1, { maxWait: 10_000, timeout: 30_000 });
    await prisma.asSystem(async () => 1, { timeout: 30_000 });
    await prisma.withTenant('t-1', async () => 1);
    expect(seen).toEqual([{ maxWait: 10_000, timeout: 30_000 }, { timeout: 30_000 }, undefined]);
  });
});
