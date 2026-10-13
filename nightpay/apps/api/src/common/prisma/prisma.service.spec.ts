import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from './prisma.service';

/**
 * Verifica el comportamiento del middleware Prisma de aislamiento por tenant.
 * NO usa DB real — mockea $use para capturar los params que pasarían a cada query.
 */

function makeCls(ctx: { tenantId?: string } | undefined) {
  return {
    get: vi.fn().mockReturnValue(ctx),
  };
}

function runMiddleware(
  prisma: PrismaService,
  params: { model?: string; action: string; args?: Record<string, unknown> },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mws = (prisma as any)._middlewares as Array<any>;
  const fn = mws?.[0];
  if (!fn) throw new Error('middleware not registered');
  return fn(params, (p: unknown) => Promise.resolve(p));
}

/**
 * Instala el middleware simulando onModuleInit sin conectar a DB real.
 */
async function installMiddleware(prisma: PrismaService) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any)._middlewares = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any).$use = (fn: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any)._middlewares.push(fn);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any).$connect = vi.fn();
  await prisma.onModuleInit();
}

describe('PrismaService tenant middleware', () => {
  let prisma: PrismaService;
  let cls: ReturnType<typeof makeCls>;

  beforeEach(async () => {
    cls = makeCls({ tenantId: 'tenant-A' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma = new PrismaService(cls as any);
    await installMiddleware(prisma);
  });

  it('injects tenantId into findMany where', async () => {
    const result = await runMiddleware(prisma, {
      model: 'Payment',
      action: 'findMany',
      args: { where: { status: 'AUTHORIZED' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).args.where).toEqual({ status: 'AUTHORIZED', tenantId: 'tenant-A' });
  });

  it('injects tenantId into create data', async () => {
    const result = await runMiddleware(prisma, {
      model: 'Payment',
      action: 'create',
      args: { data: { amountCents: 1000 } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).args.data).toEqual({ amountCents: 1000, tenantId: 'tenant-A' });
  });

  it('does NOT inject on non-tenant-scoped models (Venue)', async () => {
    const result = await runMiddleware(prisma, {
      model: 'Venue',
      action: 'findMany',
      args: { where: { slug: 'luna-vlc' } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).args.where).toEqual({ slug: 'luna-vlc' });
  });

  it('cross-tenant: user in tenant-A cannot query tenant-B payments via explicit where', async () => {
    // Usuario malicioso intenta poner tenantId de otro venue
    const result = await runMiddleware(prisma, {
      model: 'Payment',
      action: 'findMany',
      args: { where: { tenantId: 'tenant-B' } },
    });
    // El middleware SOBREESCRIBE con el tenantId del CLS (A), ignorando el intento
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).args.where.tenantId).toBe('tenant-A');
  });

  it('lets system queries pass when tenantId missing (seed/CLI)', async () => {
    cls.get.mockReturnValue(undefined);
    const result = await runMiddleware(prisma, {
      model: 'Payment',
      action: 'findMany',
      args: { where: {} },
    });
    // Sin tenant, sin inyección — RLS bypass se activa en código explícito (asSystem)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).args.where.tenantId).toBeUndefined();
  });
});

describe('PrismaService.acrossVenues', () => {
  it('dentro no filtra por local; fuera el contexto sigue igual', async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = new PrismaService(cls as any);
    await installMiddleware(prisma);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$transaction = async (fn: (tx: unknown) => unknown) => fn({ $executeRawUnsafe: vi.fn() });
    const query = { model: 'WalletChargeRequest', action: 'findFirst', args: { where: { walletId: 'w-1' } } };

    await cls.run(async () => {
      cls.set('ctx', { tenantId: 'tenant-A' });
      const inside = await prisma.acrossVenues(() => runMiddleware(prisma, structuredClone(query)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((inside as any).args.where).toEqual({ walletId: 'w-1' });
      const outside = await runMiddleware(prisma, structuredClone(query));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((outside as any).args.where).toEqual({ walletId: 'w-1', tenantId: 'tenant-A' });
    });
  });
});
