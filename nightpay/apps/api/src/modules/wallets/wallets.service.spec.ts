import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { WalletsService } from './wallets.service';

/**
 * Tests con mocks de Prisma — no toca DB. Cubrimos lo que la DB no garantiza
 * sola: orden de validaciones, generación de earnings para OPERATOR, idempotency
 * de consume, semantica del refund CARD vs CREDIT, rollback de consumption.
 */

const TENANT = 't-1';
const WALLET_ID = 'w-1';
const PAYMENT_ID = 'p-1';
const USER_OP = 'u-op';
const USER_WAITER = 'u-wt';

interface WalletRow {
  id: string;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  tenantId: string;
  expiresAt: Date | null;
}

interface PrismaMockOptions {
  walletRow?: WalletRow | null;
  walletStatus?: WalletRow['status'];
  walletBalance?: number;
  providerRole?: 'OPERATOR' | 'WAITER' | 'MANAGER' | 'OWNER' | null;
  providerCommissionBps?: number | null;
  existingConsumption?: { id: string; reversedAt?: Date | null; amountCents: number; earning?: { id: string; commissionCents: number } } | null;
}

function makeService(opts: PrismaMockOptions = {}) {
  const wallet: WalletRow = opts.walletRow ?? {
    id: WALLET_ID,
    balanceCents: opts.walletBalance ?? 50_000,
    status: opts.walletStatus ?? 'ACTIVE',
    tenantId: TENANT,
    expiresAt: null,
  };

  const createdConsumptions: Array<Record<string, unknown>> = [];
  const createdEarnings: Array<Record<string, unknown>> = [];
  let txWalletUpdates: Array<Record<string, unknown>> = [];

  // Mock $queryRaw returns a SNAPSHOT of the locked wallet row.
  // En producción la DB devuelve una copia (no aliased con el "estado en memoria"
  // del wallet); replicamos eso aquí para evitar falsos positivos donde un
  // update posterior mutaba w.balanceCents en el caller.
  const queryRawMock = vi.fn().mockImplementation(async () => [{ ...wallet }]);

  const findManyMock = vi.fn().mockResolvedValue([
    { id: PAYMENT_ID, availableAmountCents: wallet.balanceCents },
  ]);

  const txMock = {
    $queryRaw: queryRawMock,
    payment: {
      findMany: findManyMock,
    },
    walletConsumption: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const c = { id: `c-${createdConsumptions.length + 1}`, ...data };
        createdConsumptions.push(c);
        return c;
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(opts.existingConsumption ?? null),
      update: vi.fn().mockResolvedValue({}),
    },
    operatorEarning: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const e = { id: `e-${createdEarnings.length + 1}`, ...data };
        createdEarnings.push(e);
        return e;
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    clientWallet: {
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        txWalletUpdates.push(data);
        // simula la mutación en el row local
        if (typeof data.balanceCents === 'number') {
          wallet.balanceCents = data.balanceCents;
        } else if (
          typeof data.balanceCents === 'object' &&
          data.balanceCents !== null &&
          'increment' in (data.balanceCents as Record<string, unknown>)
        ) {
          wallet.balanceCents += Number(
            (data.balanceCents as Record<string, unknown>).increment,
          );
        }
        if (data.status) wallet.status = data.status as WalletRow['status'];
        if (data.expiresAt) wallet.expiresAt = data.expiresAt as Date;
        return wallet;
      }),
      findUnique: vi.fn().mockResolvedValue(wallet),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'w-new',
        qrToken: 'tok-abc123',
        ...data,
      })),
      findFirst: vi.fn().mockResolvedValue(wallet),
    },
    venue: {
      // Sin ajustes propios: la comisión por defecto (90 % en servicios de chica).
      findUnique: vi.fn().mockResolvedValue({ operatorCommissionDefaults: null }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(
        opts.providerRole
          ? { role: opts.providerRole, commissionBps: opts.providerCommissionBps ?? null }
          : null,
      ),
    },
  };

  const prismaMock = {
    asSystem: vi.fn().mockImplementation(async <T>(cb: (tx: typeof txMock) => Promise<T>) => cb(txMock)),
    $transaction: vi.fn().mockImplementation(async <T>(cb: (tx: typeof txMock) => Promise<T>) => cb(txMock)),
    // El refundCardFlow llama prisma.clientWallet.update fuera de transacción
    // tras los refunds PSP. Delegamos al mock del tx para mantener estado.
    clientWallet: {
      update: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) =>
        txMock.clientWallet.update(args),
      ),
    },
    venue: { findUnique: vi.fn().mockResolvedValue({ walletGroup: 'principal' }) },
  };

  const auditMock = { log: vi.fn().mockResolvedValue(undefined) };

  // Mock RefundsService — devuelve éxito por defecto. Tests CARD pueden
  // override el comportamiento para simular fallos.
  const refundsMock = {
    refund: vi.fn().mockImplementation(async (req: { paymentId: string; amountCents: number }) => ({
      id: `r-${Date.now()}-${Math.random()}`,
      paymentId: req.paymentId,
      amountCents: req.amountCents,
      status: 'SUCCEEDED' as const,
      providerRefundId: 'psp-refund-1',
    })),
  };

  const moduleRefMock = {
    // En test asumimos que CUALQUIER provider que pidamos resolve a refundsMock.
    // Solo hay un caller (onModuleInit pide RefundsService) — no hay ambigüedad.
    get: vi.fn().mockReturnValue(refundsMock),
  };

  const svc = new WalletsService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auditMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moduleRefMock as any,
  );
  // No hay onModuleInit — la resolución de RefundsService es lazy via getRefundsService().
  return {
    svc,
    prismaMock,
    txMock,
    auditMock,
    refundsMock,
    moduleRefMock,
    wallet,
    createdConsumptions,
    createdEarnings,
    txWalletUpdates,
  };
}

describe('WalletsService.createEmpty', () => {
  it('creates wallet with balance 0 and base64url qrToken', async () => {
    const { svc, txMock } = makeService();
    const w = await svc.createEmpty({ tenantId: TENANT, identifier: 'phone-123' });
    expect(w.id).toBe('w-new');
    expect(w.qrToken).toBeDefined();
    expect(txMock.clientWallet.create).toHaveBeenCalledOnce();
    const callArgs = (txMock.clientWallet.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.data.tenantId).toBe(TENANT);
    expect(callArgs.data.identifier).toBe('phone-123');
    expect(callArgs.data.qrToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // Saldo NightPay: código corto para el cliente y grupo de locales.
    expect(callArgs.data.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(callArgs.data.walletGroup).toBe('principal');
  });
});

describe('WalletsService.creditFromTopUp', () => {
  it('adds amount to balance atomically', async () => {
    const { svc, txMock, wallet } = makeService({ walletBalance: 1000 });
    const result = await svc.creditFromTopUp({
      tenantId: TENANT,
      walletId: WALLET_ID,
      amountCents: 5000,
      paymentId: PAYMENT_ID,
    });
    expect(result.newBalanceCents).toBe(6000);
    expect(txMock.clientWallet.update).toHaveBeenCalledOnce();
    expect(wallet.balanceCents).toBe(6000);
  });

  it('rejects negative or zero amount', async () => {
    const { svc } = makeService();
    await expect(
      svc.creditFromTopUp({ tenantId: TENANT, walletId: WALLET_ID, amountCents: 0, paymentId: PAYMENT_ID }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects credit on non-ACTIVE wallet', async () => {
    const { svc } = makeService({ walletStatus: 'REFUNDED' });
    await expect(
      svc.creditFromTopUp({ tenantId: TENANT, walletId: WALLET_ID, amountCents: 1000, paymentId: PAYMENT_ID }),
    ).rejects.toThrow(ConflictException);
  });

  it('throws ForbiddenException when wallet belongs to a different tenant', async () => {
    const { svc } = makeService({
      walletRow: {
        id: WALLET_ID,
        balanceCents: 5000,
        status: 'ACTIVE',
        tenantId: 'OTHER-TENANT',
        expiresAt: null,
      },
    });
    await expect(
      svc.creditFromTopUp({ tenantId: TENANT, walletId: WALLET_ID, amountCents: 1000, paymentId: PAYMENT_ID }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('WalletsService.consume', () => {
  const baseInput = (overrides: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    walletId: WALLET_ID,
    providedByUserId: USER_OP,
    idempotencyKey: 'idem-12345',
    dto: { amountCents: 2000, category: 'time' },
    ...overrides,
  });

  it('debits balance + creates consumption (no earning when WAITER)', async () => {
    const { svc, createdConsumptions, createdEarnings, wallet } = makeService({
      providerRole: 'WAITER',
      walletBalance: 10_000,
    });
    const result = await svc.consume(baseInput({ providedByUserId: USER_WAITER }));
    expect(result.newBalanceCents).toBe(8000);
    expect(result.earningCreated).toBe(false);
    expect(createdConsumptions).toHaveLength(1);
    expect(createdEarnings).toHaveLength(0);
    expect(wallet.balanceCents).toBe(8000);
  });

  it('creates OperatorEarning when provider is OPERATOR with commissionBps', async () => {
    const { svc, createdEarnings } = makeService({
      providerRole: 'OPERATOR',
      providerCommissionBps: 9000, // 90%
      walletBalance: 10_000,
    });
    const result = await svc.consume(baseInput({ dto: { amountCents: 2000, category: 'CHICA_SERVICE' } })); // 20€
    expect(result.earningCreated).toBe(true);
    // 2000 * 9000 / 10000 = 1800 cents
    expect(result.earningCommissionCents).toBe(1800);
    expect(createdEarnings).toHaveLength(1);
    expect(createdEarnings[0].consumptionId).toBeDefined();
    expect(createdEarnings[0].commissionCents).toBe(1800);
  });

  it('chica sin % propio → la comisión por defecto del local (antes no se le apuntaba nada)', async () => {
    const { svc, createdEarnings } = makeService({ providerRole: 'OPERATOR', providerCommissionBps: null, walletBalance: 10_000 });
    const result = await svc.consume(baseInput({ dto: { amountCents: 2000, category: 'CHICA_SERVICE' } }));
    expect(result.earningCommissionCents).toBe(1800);
    expect(createdEarnings[0].commissionBps).toBe(9000);
  });

  it('venta del local (barra) → nada para la chica, como con tarjeta', async () => {
    const { svc, createdEarnings } = makeService({ providerRole: 'OPERATOR', providerCommissionBps: 9000, walletBalance: 10_000 });
    const result = await svc.consume(baseInput({ dto: { amountCents: 2000, category: 'VENUE_BAR' } }));
    expect(result.earningCreated).toBe(false);
    expect(createdEarnings).toHaveLength(0);
  });

  it('rejects when balance is insufficient', async () => {
    const { svc, createdConsumptions } = makeService({
      providerRole: 'OPERATOR',
      providerCommissionBps: 9000,
      walletBalance: 1000, // only 10€
    });
    await expect(svc.consume(baseInput({ dto: { amountCents: 5000, category: 'time' } }))).rejects.toThrow(
      ConflictException,
    );
    expect(createdConsumptions).toHaveLength(0);
  });

  it('rejects on non-ACTIVE wallet', async () => {
    const { svc } = makeService({ providerRole: 'OPERATOR', walletStatus: 'REFUNDED' });
    await expect(svc.consume(baseInput())).rejects.toThrow(ConflictException);
  });

  it('marks wallet DEPLETED when balance reaches exactly 0', async () => {
    const { svc, wallet } = makeService({
      providerRole: 'WAITER',
      walletBalance: 2000,
    });
    await svc.consume(baseInput({ dto: { amountCents: 2000, category: 'bar' } }));
    expect(wallet.balanceCents).toBe(0);
    expect(wallet.status).toBe('DEPLETED');
  });
});

describe('WalletsService.refund', () => {
  it('CARD method: empties balance + sets REFUNDED', async () => {
    const { svc, wallet } = makeService({ walletBalance: 3000 });
    const result = await svc.refund({
      tenantId: TENANT,
      walletId: WALLET_ID,
      actor: { userId: 'u-owner', role: 'OWNER', tenantId: TENANT },
      dto: { method: 'CARD' },
    });
    expect(result.method).toBe('CARD');
    expect(result.refundedCents).toBe(3000);
    expect(result.newStatus).toBe('REFUNDED');
    expect(wallet.balanceCents).toBe(0);
    expect(wallet.status).toBe('REFUNDED');
  });

  it('CREDIT method: keeps ACTIVE + extends expiresAt 30 days', async () => {
    const { svc, wallet } = makeService({ walletBalance: 2500 });
    const before = Date.now();
    const result = await svc.refund({
      tenantId: TENANT,
      walletId: WALLET_ID,
      actor: { userId: 'u-owner', role: 'OWNER', tenantId: TENANT },
      dto: { method: 'CREDIT' },
    });
    expect(result.newStatus).toBe('ACTIVE');
    expect(result.refundedCents).toBe(2500);
    expect(wallet.balanceCents).toBe(2500); // intacto
    expect(wallet.expiresAt).toBeTruthy();
    const expiresDelta = wallet.expiresAt!.getTime() - before;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresDelta).toBeGreaterThan(thirtyDaysMs - 5000);
    expect(expiresDelta).toBeLessThan(thirtyDaysMs + 5000);
  });

  it('rejects refund on non-ACTIVE wallet', async () => {
    const { svc } = makeService({ walletStatus: 'REFUNDED' });
    await expect(
      svc.refund({
        tenantId: TENANT,
        walletId: WALLET_ID,
        actor: { userId: 'u-owner', role: 'OWNER', tenantId: TENANT },
        dto: { method: 'CARD' },
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException when wallet missing', async () => {
    const { svc, txMock } = makeService();
    (txMock.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await expect(
      svc.refund({
        tenantId: TENANT,
        walletId: WALLET_ID,
        actor: { userId: 'u-owner', role: 'OWNER', tenantId: TENANT },
        dto: { method: 'CARD' },
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('WalletsService.reverseConsumption', () => {
  it('throws when consumption not found', async () => {
    const { svc, txMock } = makeService();
    (txMock.walletConsumption.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      svc.reverseConsumption({
        tenantId: TENANT,
        walletId: WALLET_ID,
        consumptionId: 'c-bogus',
        actorUserId: 'u-owner',
        reason: 'mistake',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws when consumption already reversed', async () => {
    const { svc } = makeService({
      existingConsumption: {
        id: 'c-1',
        reversedAt: new Date(),
        amountCents: 1000,
      },
    });
    await expect(
      svc.reverseConsumption({
        tenantId: TENANT,
        walletId: WALLET_ID,
        consumptionId: 'c-1',
        actorUserId: 'u-owner',
        reason: 'duplicate',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
