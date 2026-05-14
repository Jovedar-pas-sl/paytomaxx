import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RefundsService } from './refunds.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import type { Role } from '@nightpay/contracts';

interface PaymentFixture {
  id: string;
  tenantId: string;
  status: 'AUTHORIZED' | 'PARTIALLY_REFUNDED' | 'CREATED' | 'FAILED' | 'REFUNDED';
  availableAmountCents: number;
  providerTxId: string | null;
  provider: 'WIPAY' | 'PEANPE' | null;
}

interface UserFixture {
  totpSecret: string | null;
  email: string;
}

interface MakeOptions {
  payment?: PaymentFixture | null;
  user?: UserFixture | null;
  totpValid?: boolean;
  gatewayResult?: { providerRefundId: string; status: 'SUCCEEDED' | 'FAILED' };
  gatewayThrows?: Error;
}

function makeService(opts: MakeOptions = {}) {
  const refundCreated: Array<{ id: string; status: string }> = [];

  const prismaMock = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(opts.payment ?? null),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(opts.user ?? null),
    },
    refund: {
      create: vi.fn().mockImplementation(async ({ data }: { data: { tenantId: string } }) => {
        const refund = { id: `refund-${refundCreated.length + 1}`, status: 'PENDING', ...data };
        refundCreated.push(refund);
        return refund;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })),
    },
  };

  const clsMock = {
    get: vi.fn().mockReturnValue({ traceId: 'trace-x', userId: 'u-1', tenantId: 't-1' }),
  };

  const adapterMock = {
    refund: opts.gatewayThrows
      ? vi.fn().mockRejectedValue(opts.gatewayThrows)
      : vi.fn().mockResolvedValue(opts.gatewayResult ?? { providerRefundId: 'gw-r-1', status: 'SUCCEEDED' as const }),
  };

  const gatewaysMock = {
    get: vi.fn().mockReturnValue(adapterMock),
  };

  const paymentsMock = {
    transition: vi.fn().mockResolvedValue(undefined),
  };

  const totpMock = {
    verify: vi.fn().mockReturnValue(opts.totpValid ?? false),
  };

  const auditMock = {
    log: vi.fn().mockResolvedValue(undefined),
  };

  const metricsMock = {
    refundsCreated: { inc: vi.fn() },
    earningReversalFailed: { inc: vi.fn() },
  };

  const svc = new RefundsService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clsMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gatewaysMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paymentsMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    totpMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    auditMock as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metricsMock as any,
  );

  return { svc, prismaMock, paymentsMock, totpMock, auditMock, metricsMock, adapterMock };
}

const okPayment: PaymentFixture = {
  id: 'pay-1',
  tenantId: 't-1',
  status: 'AUTHORIZED',
  availableAmountCents: 5000,
  providerTxId: 'gw-tx-1',
  provider: 'WIPAY',
};

const enrolledUser: UserFixture = {
  email: 'manager@nightpay.local',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

const manager: { userId: string; role: Role; tenantId: string } = {
  userId: 'u-1',
  role: 'MANAGER',
  tenantId: 't-1',
};

const waiter: { userId: string; role: Role; tenantId: string } = {
  userId: 'u-2',
  role: 'WAITER',
  tenantId: 't-1',
};

describe('RefundsService.refund — authorization gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects WAITER role outright', async () => {
    const { svc } = makeService({ payment: okPayment });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, waiter)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('requires TOTP for refunds >= 100 EUR', async () => {
    const { svc } = makeService({ payment: okPayment });
    await expect(
      svc.refund({ paymentId: 'pay-1', amountCents: 10_000 }, manager),
    ).rejects.toThrow(/TOTP required/);
  });

  it('blocks refund when user has no TOTP enrolled', async () => {
    const { svc } = makeService({
      payment: okPayment,
      user: { ...enrolledUser, totpSecret: null },
    });
    await expect(
      svc.refund({ paymentId: 'pay-1', amountCents: 10_000, totpCode: '123456' }, manager),
    ).rejects.toThrow(/TOTP not enrolled/);
  });

  it('rejects invalid TOTP code', async () => {
    const { svc } = makeService({
      payment: okPayment,
      user: enrolledUser,
      totpValid: false,
    });
    await expect(
      svc.refund({ paymentId: 'pay-1', amountCents: 10_000, totpCode: '000000' }, manager),
    ).rejects.toThrow(/Invalid TOTP/);
  });

  it('does NOT require TOTP for sub-100€ refunds', async () => {
    const { svc, totpMock } = makeService({ payment: okPayment });
    const result = await svc.refund({ paymentId: 'pay-1', amountCents: 5000 }, manager);
    expect(result.status).toBe('SUCCEEDED');
    expect(totpMock.verify).not.toHaveBeenCalled();
  });
});

describe('RefundsService.refund — payment-state gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 if payment does not exist', async () => {
    const { svc } = makeService({ payment: null });
    await expect(svc.refund({ paymentId: 'ghost', amountCents: 100 }, manager)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('409 if payment is in non-refundable state (CREATED)', async () => {
    const { svc } = makeService({ payment: { ...okPayment, status: 'CREATED' } });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 100 }, manager)).rejects.toThrow(
      /Cannot refund payment in state CREATED/,
    );
  });

  it('409 if payment was already fully REFUNDED', async () => {
    const { svc } = makeService({
      payment: { ...okPayment, status: 'REFUNDED', availableAmountCents: 0 },
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 100 }, manager)).rejects.toThrow(
      ConflictException,
    );
  });

  it('400 if amount exceeds available balance', async () => {
    const { svc } = makeService({
      payment: { ...okPayment, availableAmountCents: 1000 },
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 5000 }, manager)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('409 if payment has no provider transaction id', async () => {
    const { svc } = makeService({
      payment: { ...okPayment, providerTxId: null, provider: null },
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 100 }, manager)).rejects.toThrow(
      /no provider transaction id/,
    );
  });

  it('allows refund on PARTIALLY_REFUNDED status', async () => {
    const { svc } = makeService({
      payment: { ...okPayment, status: 'PARTIALLY_REFUNDED', availableAmountCents: 2000 },
    });
    const result = await svc.refund({ paymentId: 'pay-1', amountCents: 1000 }, manager);
    expect(result.status).toBe('SUCCEEDED');
  });
});

describe('RefundsService.refund — gateway interaction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks refund FAILED when adapter returns FAILED + raises 409', async () => {
    const { svc, prismaMock, metricsMock } = makeService({
      payment: okPayment,
      gatewayResult: { providerRefundId: 'gw-r-fail', status: 'FAILED' },
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(
      /Gateway refund failed/,
    );
    expect(prismaMock.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(metricsMock.refundsCreated.inc).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('marks refund FAILED when adapter throws + raises 409', async () => {
    const { svc, prismaMock, metricsMock } = makeService({
      payment: okPayment,
      gatewayThrows: new Error('connection refused'),
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(
      /Refund gateway error/,
    );
    expect(prismaMock.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(metricsMock.refundsCreated.inc).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('uses refund.id as gateway reference (idempotency key per refund attempt)', async () => {
    const { svc, adapterMock } = makeService({ payment: okPayment });
    await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager);
    expect(adapterMock.refund).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'refund-1' }),
    );
  });
});

describe('RefundsService.refund — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns SUCCEEDED + transitions FSM + audits + metrics', async () => {
    const { svc, paymentsMock, auditMock, metricsMock } = makeService({ payment: okPayment });

    const result = await svc.refund({ paymentId: 'pay-1', amountCents: 1500 }, manager);

    expect(result).toEqual(
      expect.objectContaining({
        paymentId: 'pay-1',
        amountCents: 1500,
        status: 'SUCCEEDED',
        providerRefundId: 'gw-r-1',
      }),
    );
    expect(paymentsMock.transition).toHaveBeenCalledWith(
      'pay-1',
      { type: 'REFUND_PARTIAL', amountCents: 1500 },
      't-1', // tenantId — defensa cross-tenant
    );
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'refund.created',
        targetType: 'Payment',
        targetId: 'pay-1',
      }),
    );
    expect(metricsMock.refundsCreated.inc).toHaveBeenCalledWith({
      venue: 't-1',
      provider: 'WIPAY',
      status: 'success',
    });
  });

  it('does not throw if FSM transition rejects (race: already refunded)', async () => {
    const { svc, paymentsMock } = makeService({ payment: okPayment });
    paymentsMock.transition.mockRejectedValueOnce(
      new InvalidTransitionError('AUTHORIZED', 'REFUND_PARTIAL'),
    );
    const result = await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager);
    expect(result.status).toBe('SUCCEEDED');
  });
});
