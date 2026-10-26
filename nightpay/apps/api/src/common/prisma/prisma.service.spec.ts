import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import {
  PrismaService,
  RlsOutsideTransactionError,
  TENANT_SCOPED_MODELS,
  UnscopedTenantQueryError,
} from './prisma.service';
import { TENANT_GUC } from './rls';

/**
 * Verifica el comportamiento del middleware Prisma de aislamiento por tenant.
 * NO usa DB real — mockea $use para capturar los params que pasarían a cada query.
 */

type Params = { model?: string; action: string; args?: Record<string, unknown> | unknown[]; runInTransaction?: boolean };

function runMiddleware(prisma: PrismaService, params: Params) {
  const mws = (prisma as unknown as { _middlewares: Array<(p: Params, next: (p: Params) => unknown) => unknown> })
    ._middlewares;
  const fn = mws?.[0];
  if (!fn) throw new Error('middleware not registered');
  return fn(params, (p: Params) => Promise.resolve(p)) as Promise<Params>;
}

/** Instala el middleware simulando onModuleInit sin conectar a DB real. */
async function installMiddleware(prisma: PrismaService) {
  const target = prisma as unknown as Record<string, unknown>;
  target._middlewares = [];
  target.$use = (fn: unknown) => (target._middlewares as unknown[]).push(fn);
  target.$connect = vi.fn();
  // La comprobación del rol de la base al arrancar (sin base real: ningún rol).
  target.$queryRaw = vi.fn(async () => []);
  target.$transaction = async (fn: (tx: unknown) => unknown) => fn({ $executeRawUnsafe: vi.fn() });
  await prisma.onModuleInit();
}

function makePrisma(policy?: 'log' | 'throw') {
  const cls = new ClsService(new AsyncLocalStorage());
  const metrics = { tenantUnscopedQueries: { inc: vi.fn() }, rlsOutsideTransaction: { inc: vi.fn() } };
  const config = { get: vi.fn((k: string) => (k === 'TENANCY_UNSCOPED_QUERIES' ? policy : undefined)) };
  const prisma = new PrismaService(cls as never, config as never, metrics as never);
  return { cls, prisma, metrics };
}

function inTenant<T>(cls: ClsService, tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-1' });
    return fn();
  });
}

describe('PrismaService tenant middleware', () => {
  let prisma: PrismaService;
  let cls: ClsService;

  beforeEach(async () => {
    ({ prisma, cls } = makePrisma());
    await installMiddleware(prisma);
  });

  it('injects tenantId into findMany where', async () => {
    const result = await inTenant(cls, 'tenant-A', () =>
      runMiddleware(prisma, { model: 'Payment', action: 'findMany', args: { where: { status: 'AUTHORIZED' } } }),
    );
    expect(result.args?.where).toEqual({ status: 'AUTHORIZED', tenantId: 'tenant-A' });
  });

  it('injects tenantId into create data', async () => {
    const result = await inTenant(cls, 'tenant-A', () =>
      runMiddleware(prisma, { model: 'Payment', action: 'create', args: { data: { amountCents: 1000 } } }),
    );
    expect(result.args?.data).toEqual({ amountCents: 1000, tenantId: 'tenant-A' });
  });

  it('does NOT inject on non-tenant-scoped models (Venue)', async () => {
    const result = await inTenant(cls, 'tenant-A', () =>
      runMiddleware(prisma, { model: 'Venue', action: 'findMany', args: { where: { slug: 'luna-vlc' } } }),
    );
    expect(result.args?.where).toEqual({ slug: 'luna-vlc' });
  });

  it('cross-tenant: user in tenant-A cannot query tenant-B payments via explicit where', async () => {
    const result = await inTenant(cls, 'tenant-A', () =>
      runMiddleware(prisma, { model: 'Payment', action: 'findMany', args: { where: { tenantId: 'tenant-B' } } }),
    );
    expect((result.args?.where as { tenantId: string }).tenantId).toBe('tenant-A');
  });

  it('PaymentAttempt y EarningReversal también van por local', async () => {
    expect(TENANT_SCOPED_MODELS.has('PaymentAttempt')).toBe(true);
    expect(TENANT_SCOPED_MODELS.has('EarningReversal')).toBe(true);
    const result = await inTenant(cls, 'tenant-A', () =>
      runMiddleware(prisma, { model: 'PaymentAttempt', action: 'findMany', args: { where: { paymentId: 'p' } } }),
    );
    expect(result.args?.where).toEqual({ paymentId: 'p', tenantId: 'tenant-A' });
  });

  it('los que cruzan locales por diseño no se filtran (saldo del grupo, avisos sin local)', () => {
    for (const model of ['ClientWallet', 'WalletConsumption', 'WalletPasskey', 'WalletCard', 'WebhookDelivery', 'AuditEvent']) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(false);
    }
  });
});

describe('consultas por local sin local ni permiso explícito (fail loud)', () => {
  it('sin contexto: pasa (modo log) pero queda en la métrica', async () => {
    const { prisma, metrics } = makePrisma();
    await installMiddleware(prisma);
    const result = await runMiddleware(prisma, { model: 'Payment', action: 'findUnique', args: { where: { id: 'p' } } });
    expect(result.args?.where).toEqual({ id: 'p' });
    expect(metrics.tenantUnscopedQueries.inc).toHaveBeenCalledWith({ model: 'Payment', action: 'findUnique' });
  });

  it('con contexto de petición pública (sin local): también cuenta', async () => {
    const { prisma, cls, metrics } = makePrisma();
    await installMiddleware(prisma);
    await inTenant(cls, undefined, () => runMiddleware(prisma, { model: 'User', action: 'update', args: { where: { id: 'u' } } }));
    expect(metrics.tenantUnscopedQueries.inc).toHaveBeenCalledWith({ model: 'User', action: 'update' });
  });

  it('dentro de asSystem o acrossVenues es explícito: no cuenta', async () => {
    const { prisma, cls, metrics } = makePrisma();
    await installMiddleware(prisma);
    const q: Params = { model: 'Payment', action: 'findFirst', args: { where: { id: 'p' } } };
    await prisma.asSystem(() => runMiddleware(prisma, structuredClone(q)));
    await inTenant(cls, undefined, () => prisma.asSystem(() => runMiddleware(prisma, structuredClone(q))));
    await prisma.acrossVenues(() => runMiddleware(prisma, structuredClone(q)));
    expect(metrics.tenantUnscopedQueries.inc).not.toHaveBeenCalled();
  });

  it('asSystem con local en el contexto sigue filtrando por ese local (solo salta RLS)', async () => {
    const { prisma, cls } = makePrisma();
    await installMiddleware(prisma);
    const inside = await inTenant(cls, 'tenant-A', () =>
      prisma.asSystem(() => runMiddleware(prisma, { model: 'Payment', action: 'findFirst', args: { where: { id: 'p' } } })),
    );
    expect(inside.args?.where).toEqual({ id: 'p', tenantId: 'tenant-A' });
  });

  it('modo throw (TENANCY_UNSCOPED_QUERIES=throw): se corta la consulta', async () => {
    const { prisma } = makePrisma('throw');
    await installMiddleware(prisma);
    await expect(runMiddleware(prisma, { model: 'Payment', action: 'findMany', args: {} })).rejects.toThrow(
      UnscopedTenantQueryError,
    );
    await expect(
      prisma.asSystem(() => runMiddleware(prisma, { model: 'Payment', action: 'findMany', args: {} })),
    ).resolves.toBeDefined();
  });

  it('sin MetricsService ni ConfigService (como en los tests con BD real) funciona igual', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const prisma = new PrismaService(cls as never);
    await installMiddleware(prisma);
    await expect(runMiddleware(prisma, { model: 'Payment', action: 'count', args: {} })).resolves.toBeDefined();
  });
});

describe('PrismaService.acrossVenues', () => {
  it('dentro no filtra por local; fuera el contexto sigue igual', async () => {
    const { prisma, cls } = makePrisma();
    await installMiddleware(prisma);
    const query: Params = { model: 'WalletChargeRequest', action: 'findFirst', args: { where: { walletId: 'w-1' } } };

    await cls.run(async () => {
      cls.set('ctx', { tenantId: 'tenant-A' });
      const inside = await prisma.acrossVenues(() => runMiddleware(prisma, structuredClone(query)));
      expect(inside.args?.where).toEqual({ walletId: 'w-1' });
      const outside = await runMiddleware(prisma, structuredClone(query));
      expect(outside.args?.where).toEqual({ walletId: 'w-1', tenantId: 'tenant-A' });
      expect(cls.get('ctx')).toEqual({ tenantId: 'tenant-A' });
    });
  });
});

describe('tablas con FORCE RLS fuera de una transacción', () => {
  it('se avisa (métrica) y en modo log la consulta sigue', async () => {
    const { prisma, metrics } = makePrisma();
    await installMiddleware(prisma);
    await expect(runMiddleware(prisma, { model: 'OperatorEarning', action: 'findMany', args: {} })).resolves.toBeDefined();
    await runMiddleware(prisma, { action: 'queryRaw', args: [['SELECT * FROM client_wallets WHERE id = ', ''], 'w'] });
    await runMiddleware(prisma, { model: 'Payment', action: 'findUnique', args: { where: { id: 'p' }, include: { peanpeCall: true } } });
    expect(metrics.rlsOutsideTransaction.inc).toHaveBeenCalledWith({ target: 'OperatorEarning', action: 'findMany' });
    expect(metrics.rlsOutsideTransaction.inc).toHaveBeenCalledWith({ target: 'client_wallets', action: 'queryRaw' });
    expect(metrics.rlsOutsideTransaction.inc).toHaveBeenCalledWith({ target: 'Payment (relación)', action: 'findUnique' });
  });

  it('dentro de una transacción (withTenant, asSystem, acrossVenues, $transaction) no cuenta', async () => {
    const { prisma, metrics } = makePrisma();
    await installMiddleware(prisma);
    await runMiddleware(prisma, { model: 'ClientWallet', action: 'findMany', args: {}, runInTransaction: true });
    await runMiddleware(prisma, { action: 'queryRaw', args: [['SELECT 1 FROM operator_payouts']], runInTransaction: true });
    expect(metrics.rlsOutsideTransaction.inc).not.toHaveBeenCalled();
  });

  it('el resto de consultas fuera de transacción no cuentan', async () => {
    const { prisma, metrics } = makePrisma();
    await installMiddleware(prisma);
    await runMiddleware(prisma, { model: 'Venue', action: 'findMany', args: {} });
    await runMiddleware(prisma, { action: 'queryRaw', args: [['SELECT 1 FROM payments']] });
    expect(metrics.rlsOutsideTransaction.inc).not.toHaveBeenCalled();
  });

  it('modo throw: se corta (con un rol sin superusuario no vería filas)', async () => {
    const { prisma } = makePrisma('throw');
    await installMiddleware(prisma);
    await expect(
      prisma.asSystem(() => runMiddleware(prisma, { model: 'WalletConsumption', action: 'count', args: {} })),
    ).rejects.toThrow(RlsOutsideTransactionError);
    await expect(
      runMiddleware(prisma, { model: 'WalletConsumption', action: 'count', args: {}, runInTransaction: true }),
    ).resolves.toBeDefined();
  });
});

describe('el local en la sesión de la base ($transaction / withTenant)', () => {
  type Tx = { $executeRaw: ReturnType<typeof vi.fn>; $executeRawUnsafe: ReturnType<typeof vi.fn> };
  let tx: Tx;
  let base: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tx = { $executeRaw: vi.fn().mockResolvedValue(1), $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
    // El $transaction de Prisma (la clase base): la transacción es `tx`; el lote devuelve un resultado por sentencia.
    const parent = Object.getPrototypeOf(PrismaService.prototype) as { $transaction: (...a: unknown[]) => unknown };
    base = vi
      .spyOn(parent, '$transaction')
      .mockImplementation(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: Tx) => unknown)(tx) : (arg as unknown[]).map((_, i) => `r${i}`),
      );
  });
  afterEach(() => base.mockRestore());

  function setConfigCalls(): Prisma.Sql[] {
    return tx.$executeRaw.mock.calls.map((c) => c[0] as Prisma.Sql);
  }

  it('con local en el contexto: lo pone en la sesión antes que nada (solo para esa transacción)', async () => {
    const { prisma, cls } = makePrisma();
    const order: string[] = [];
    tx.$executeRaw.mockImplementation(async () => order.push('set_config'));
    await inTenant(cls, 'tenant-A', () => prisma.$transaction(async () => order.push('trabajo')));
    expect(order).toEqual(['set_config', 'trabajo']);
    const [sql] = setConfigCalls();
    expect(sql!.text).toMatch(/SELECT set_config\(\$1, \$2, true\)/);
    expect(sql!.values).toEqual([TENANT_GUC, 'tenant-A']);
  });

  it('sin local, en asSystem o en acrossVenues: nada (llevan bypass o no hay local)', async () => {
    const { prisma, cls } = makePrisma();
    await prisma.$transaction(async () => 1);
    await inTenant(cls, undefined, () => prisma.$transaction(async () => 1));
    await inTenant(cls, 'tenant-A', () => prisma.asSystem(async () => 1));
    await inTenant(cls, 'tenant-A', () => prisma.acrossVenues(async () => 1));
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL app.bypass_rls = 'on'`);
  });

  it('withTenant: ese local en la sesión y en el contexto (sin bypass), también dentro de asSystem', async () => {
    const { prisma, cls } = makePrisma();
    const seen = await inTenant(cls, 'tenant-A', () =>
      prisma.asSystem(() => prisma.withTenant('tenant-B', async () => cls.get('ctx'))),
    );
    expect(seen).toMatchObject({ tenantId: 'tenant-B', system: false, acrossVenues: false });
    expect(setConfigCalls().map((s) => s.values)).toEqual([[TENANT_GUC, 'tenant-B']]);
    await expect(prisma.withTenant('', async () => 1)).rejects.toThrow(/necesita un local/);
  });

  it('en lote: la sentencia del local va primera y su resultado no se devuelve', async () => {
    const { prisma, cls } = makePrisma();
    const out = await inTenant(cls, 'tenant-A', () =>
      prisma.$transaction([Promise.resolve('a'), Promise.resolve('b')] as never),
    );
    expect((base.mock.calls[0]![0] as unknown[]).length).toBe(3);
    expect(out).toEqual(['r1', 'r2']);
    const plain = await prisma.$transaction([Promise.resolve('a')] as never);
    expect(plain).toEqual(['r0']);
  });
});
