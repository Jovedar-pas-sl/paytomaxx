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
  provider: 'WIPAY' | 'PEANPE' | 'REDSYS' | null;
  walletId?: string | null;
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
  // Fase 1C: devoluciones iguales ya registradas en los últimos 7 días.
  similarRefunds?: number;
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
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
      create: vi.fn().mockImplementation(async ({ data }: { data: { tenantId: string } }) => {
        const refund = { id: `refund-${refundCreated.length + 1}`, status: 'PENDING', ...data };
        refundCreated.push(refund);
        return refund;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })),
      count: vi.fn().mockResolvedValue(opts.similarRefunds ?? 0),
    },
  };
  // Fase 1C: la reserva de la devolución va en una transacción con candado.
  Object.assign(prismaMock, {
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock)),
  });

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
    applyRefundToEarning: vi.fn().mockResolvedValue(undefined),
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

describe('RefundsService.registerBankRefund — devolución hecha en el portal de BBVA (Fase 1C)', () => {
  beforeEach(() => vi.clearAllMocks());

  const owner: { userId: string; role: Role; tenantId: string } = {
    userId: 'u-owner',
    role: 'OWNER',
    tenantId: 't-1',
  };
  const redsysPayment: PaymentFixture = { ...okPayment, provider: 'REDSYS', availableAmountCents: 10_500 };

  it('apunta la devolución sin llamar al banco, ajusta el cobro y descuenta a la chica', async () => {
    const { svc, prismaMock, paymentsMock, adapterMock, auditMock } = makeService({ payment: redsysPayment });
    const result = await svc.registerBankRefund(
      {
        paymentId: 'pay-1',
        amountCents: 10_500,
        reason: 'Cliente no reconoce el cargo',
        bankReference: 'DEV-778812',
        refundedAt: new Date('2026-10-12T12:00:00Z'),
      },
      owner,
    );

    expect(adapterMock.refund).not.toHaveBeenCalled();
    expect(prismaMock.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 10_500,
        status: 'PENDING',
        providerRefundId: 'DEV-778812',
        registeredManually: true,
        bankRefundedAt: new Date('2026-10-12T12:00:00Z'),
        requestedBy: 'u-owner',
      }),
    });
    expect(paymentsMock.transition).toHaveBeenCalledWith(
      'pay-1',
      { type: 'REFUND_PARTIAL', amountCents: 10_500 },
      't-1',
    );
    expect(prismaMock.refund.update).toHaveBeenCalledWith({ where: { id: 'refund-1' }, data: { status: 'SUCCEEDED' } });
    expect(paymentsMock.applyRefundToEarning).toHaveBeenCalledWith('pay-1', 'refund-1', 10_500);
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'refund.bank_registered' }));
    expect(result).toMatchObject({ status: 'SUCCEEDED', providerRefundId: 'DEV-778812' });
  });

  it('solo el dueño', async () => {
    const { svc } = makeService({ payment: redsysPayment });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 100, reason: 'motivo' }, manager),
    ).rejects.toThrow(ForbiddenException);
  });

  it('cobro de otro local → no existe', async () => {
    const { svc } = makeService({ payment: { ...redsysPayment, tenantId: 't-otro' } });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 100, reason: 'motivo' }, owner),
    ).rejects.toThrow(NotFoundException);
  });

  it('no deja devolver más de lo que queda', async () => {
    const { svc, prismaMock } = makeService({ payment: redsysPayment });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 10_501, reason: 'motivo' }, owner),
    ).rejects.toThrow(BadRequestException);
    expect(prismaMock.refund.create).not.toHaveBeenCalled();
  });

  it('cobro sin pagar → no', async () => {
    const { svc } = makeService({ payment: { ...redsysPayment, status: 'FAILED' } });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 100, reason: 'motivo' }, owner),
    ).rejects.toThrow(ConflictException);
  });

  it('recarga de wallet → se devuelve desde Wallets (si no, el saldo seguiría gastable)', async () => {
    const { svc } = makeService({ payment: { ...redsysPayment, walletId: 'w-1' } });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 100, reason: 'motivo' }, owner),
    ).rejects.toThrow(/Wallets/);
  });

  it('misma devolución ya registrada esta semana → pide confirmar; confirmada, se apunta', async () => {
    const { svc, prismaMock } = makeService({ payment: redsysPayment, similarRefunds: 1 });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 500, reason: 'motivo' }, owner),
    ).rejects.toThrow(/confírmalo/);
    expect(prismaMock.refund.create).not.toHaveBeenCalled();

    await svc.registerBankRefund(
      { paymentId: 'pay-1', amountCents: 500, reason: 'motivo', confirmDuplicate: true },
      owner,
    );
    expect(prismaMock.refund.create).toHaveBeenCalledTimes(1);
  });

  it('el cobro ya no admite la devolución (otra a la vez) → FAILED, 409 y sin descontar a la chica', async () => {
    const { svc, prismaMock, paymentsMock } = makeService({ payment: redsysPayment });
    paymentsMock.transition.mockRejectedValueOnce(new InvalidTransitionError('PARTIALLY_REFUNDED', 'REFUND_PARTIAL'));
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 5000, reason: 'motivo' }, owner),
    ).rejects.toThrow(ConflictException);
    expect(prismaMock.refund.update).toHaveBeenCalledWith({ where: { id: 'refund-1' }, data: { status: 'FAILED' } });
    expect(paymentsMock.applyRefundToEarning).not.toHaveBeenCalled();
  });

  it('fecha futura → no', async () => {
    const { svc } = makeService({ payment: redsysPayment });
    await expect(
      svc.registerBankRefund(
        { paymentId: 'pay-1', amountCents: 100, reason: 'motivo', refundedAt: new Date(Date.now() + 86_400_000) },
        owner,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
