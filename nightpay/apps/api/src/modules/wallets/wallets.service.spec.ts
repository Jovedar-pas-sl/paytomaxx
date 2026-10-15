import { describe, it, expect, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';

/**
 * Tests con mocks de Prisma — no toca DB. Cubrimos lo que la DB no garantiza
 * sola: el alta del saldo y el orden de validaciones al anular un consumo.
 */

const TENANT = 't-1';
const WALLET_ID = 'w-1';

interface PrismaMockOptions {
  existingConsumption?: { id: string; reversedAt?: Date | null; amountCents: number } | null;
}

function makeService(opts: PrismaMockOptions = {}) {
  const wallet = { id: WALLET_ID, balanceCents: 50_000, status: 'ACTIVE', tenantId: TENANT };
  const txMock = {
    $queryRaw: vi.fn().mockImplementation(async () => [{ ...wallet }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    walletConsumption: {
      findFirst: vi.fn().mockResolvedValue(opts.existingConsumption ?? null),
      update: vi.fn().mockResolvedValue({}),
    },
    operatorEarning: { update: vi.fn().mockResolvedValue({}) },
    clientWallet: {
      update: vi.fn().mockResolvedValue(wallet),
      findUnique: vi.fn().mockResolvedValue(wallet),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'w-new',
        qrToken: 'tok-abc123',
        ...data,
      })),
    },
  };
  const prismaMock = {
    asSystem: vi.fn().mockImplementation(async <T>(cb: (tx: typeof txMock) => Promise<T>) => cb(txMock)),
    $transaction: vi.fn().mockImplementation(async <T>(cb: (tx: typeof txMock) => Promise<T>) => cb(txMock)),
    venue: { findUnique: vi.fn().mockResolvedValue({ walletGroup: 'principal' }) },
  };
  const auditMock = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new WalletsService(prismaMock as never, auditMock as never);
  return { svc, prismaMock, txMock, auditMock };
}

describe('WalletsService.createEmpty', () => {
  it('creates wallet with balance 0 and base64url qrToken', async () => {
    const { svc, txMock } = makeService();
    const w = await svc.createEmpty({ tenantId: TENANT, identifier: 'phone-123' });
    expect(w.id).toBe('w-new');
    expect(w.qrToken).toBeDefined();
    expect(txMock.clientWallet.create).toHaveBeenCalledOnce();
    const callArgs = txMock.clientWallet.create.mock.calls[0]![0];
    expect(callArgs.data.tenantId).toBe(TENANT);
    expect(callArgs.data.identifier).toBe('phone-123');
    expect(callArgs.data.qrToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // Saldo NightPay: código corto para el cliente y grupo de locales.
    expect(callArgs.data.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(callArgs.data.walletGroup).toBe('principal');
  });
});

describe('WalletsService.reverseConsumption', () => {
  it('throws when consumption not found', async () => {
    const { svc, txMock } = makeService();
    txMock.walletConsumption.findFirst.mockResolvedValue(null);
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
      existingConsumption: { id: 'c-1', reversedAt: new Date(), amountCents: 1000 },
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
