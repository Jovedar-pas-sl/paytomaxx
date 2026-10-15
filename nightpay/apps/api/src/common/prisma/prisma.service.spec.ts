import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService, TENANT_SCOPED_MODELS, UnscopedTenantQueryError } from './prisma.service';

/**
 * Verifica el comportamiento del middleware Prisma de aislamiento por tenant.
 * NO usa DB real — mockea $use para capturar los params que pasarían a cada query.
 */

type Params = { model?: string; action: string; args?: Record<string, unknown> };

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
  target.$transaction = async (fn: (tx: unknown) => unknown) => fn({ $executeRawUnsafe: vi.fn() });
  await prisma.onModuleInit();
}

function makePrisma(policy?: 'log' | 'throw') {
  const cls = new ClsService(new AsyncLocalStorage());
  const metrics = { tenantUnscopedQueries: { inc: vi.fn() } };
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
