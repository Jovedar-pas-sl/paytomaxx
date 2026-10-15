import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadGatewayException,
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

interface RefundRowFixture {
  id: string;
  tenantId: string;
  paymentId: string;
  amountCents: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  createdAt: Date;
}

interface MakeOptions {
  payment?: PaymentFixture | null;
  user?: UserFixture | null;
  totpValid?: boolean;
  gatewayResult?: { providerRefundId: string; status: 'SUCCEEDED' | 'FAILED' | 'PENDING' };
  gatewayThrows?: Error;
  // Fase 1C: devoluciones iguales ya registradas en los últimos 7 días.
  similarRefunds?: number;
  /** Lo que reservan otras devoluciones pendientes del cobro. */
  reservedCents?: number;
  /** Devolución que busca resolvePending. */
  existingRefund?: RefundRowFixture | null;
  /** Lo que esta persona ya devolvió por la pasarela en este cobro / en 24 h. */
  userSamePaymentCents?: number;
  userLastDayCents?: number;
}

function makeService(opts: MakeOptions = {}) {
  const refundCreated: Array<{ id: string; status: string }> = [];
  const payment = opts.payment ?? null;

  const prismaMock = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(payment),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(opts.user ?? null),
    },
    refund: {
      // Con requestedBy: lo devuelto por la persona (2FA); si no, lo reservado del cobro.
      aggregate: vi.fn().mockImplementation(async ({ where }: { where: { requestedBy?: string; paymentId?: string } }) => {
        if (!where.requestedBy) return { _sum: { amountCents: opts.reservedCents ?? 0 } };
        const cents = where.paymentId ? opts.userSamePaymentCents : opts.userLastDayCents;
        return { _sum: { amountCents: cents ?? 0 } };
      }),
      create: vi.fn().mockImplementation(async ({ data }: { data: { id?: string; tenantId: string } }) => {
        const refund = { id: data.id ?? `refund-${refundCreated.length + 1}`, status: 'PENDING', ...data };
        refundCreated.push(refund);
        return refund;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(opts.similarRefunds ?? 0),
      findFirst: vi.fn().mockResolvedValue(opts.existingRefund ?? null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  // La reserva va en una transacción con la fila del cobro bloqueada (FOR UPDATE).
  const lockedRow = payment
    ? { availableAmountCents: payment.availableAmountCents, status: payment.status }
    : null;
  Object.assign(prismaMock, {
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FOR UPDATE') ? (lockedRow ? [lockedRow] : []) : [{ ok: 1 }],
    ),
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

  // transition() de verdad ejecuta `prepare` con la fila bloqueada dentro de su
  // transacción: aquí igual, para que las comprobaciones de la reserva corran.
  const paymentsMock = {
    transition: vi.fn().mockImplementation(
      async (
        _id: string,
        _event: unknown,
        _tenant: string,
        topts?: { prepare?: (tx: unknown, locked: unknown) => Promise<unknown> },
      ) => {
        if (topts?.prepare) await topts.prepare(prismaMock, { ...(lockedRow ?? {}) });
      },
    ),
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
    prismaMock as any,
    clsMock as any,
    gatewaysMock as any,
    paymentsMock as any,
    totpMock as any,
    auditMock as any,
    metricsMock as any,
  );

  return { svc, prismaMock, paymentsMock, totpMock, auditMock, metricsMock, adapterMock, gatewaysMock };
}

const okPayment: PaymentFixture = {
  id: 'pay-1',
  tenantId: 't-1',
  status: 'AUTHORIZED',
  availableAmountCents: 5000,
  providerTxId: 'gw-tx-1',
  provider: 'WIPAY',
};
/** Cobro grande para probar el 2FA (≥ 100 €) sin chocar con el importe devolvible. */
const bigPayment: PaymentFixture = { ...okPayment, availableAmountCents: 50_000 };

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

const owner: { userId: string; role: Role; tenantId: string } = {
  userId: 'u-owner',
  role: 'OWNER',
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

  it('requires TOTP for refunds >= 100 EUR (code TOTP_REQUIRED para que el panel pida el código)', async () => {
    const { svc, prismaMock } = makeService({ payment: bigPayment });
    const err = await svc.refund({ paymentId: 'pay-1', amountCents: 10_000 }, manager).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'TOTP_REQUIRED',
      message: expect.stringMatching(/código 2FA.*100,00 €/),
    });
    expect(prismaMock.refund.create).not.toHaveBeenCalled();
  });

  it('blocks refund when user has no TOTP enrolled', async () => {
    const { svc } = makeService({
      payment: bigPayment,
      user: { ...enrolledUser, totpSecret: null },
    });
    await expect(
      svc.refund({ paymentId: 'pay-1', amountCents: 10_000, totpCode: '123456' }, manager),
    ).rejects.toThrow(/no la tienes activada/);
  });

  it('rejects invalid TOTP code', async () => {
    const { svc, prismaMock } = makeService({
      payment: bigPayment,
      user: enrolledUser,
      totpValid: false,
    });
    await expect(
      svc.refund({ paymentId: 'pay-1', amountCents: 10_000, totpCode: '000000' }, manager),
    ).rejects.toThrow(/2FA incorrecto/);
    expect(prismaMock.refund.create).not.toHaveBeenCalled();
  });

  it('código válido → pasa y queda en el registro que se pidió 2FA', async () => {
    const { svc, auditMock } = makeService({ payment: bigPayment, user: enrolledUser, totpValid: true });
    const result = await svc.refund({ paymentId: 'pay-1', amountCents: 10_000, totpCode: '123456' }, manager);
    expect(result.status).toBe('SUCCEEDED');
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refund.created', payload: expect.objectContaining({ twoFactorRequired: true }) }),
    );
  });

  it('99,99 € × N en el MISMO cobro: la que llega a 100 € acumulados pide el código', async () => {
    const { svc, totpMock } = makeService({ payment: bigPayment, userSamePaymentCents: 9_999, userLastDayCents: 9_999 });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 9_999 }, manager)).rejects.toThrow(
      /en este cobro sumas 199,98 €/,
    );
    expect(totpMock.verify).not.toHaveBeenCalled();
  });

  it('99,99 € × N en cobros DISTINTOS: pide el código por lo devuelto en 24 h', async () => {
    const { svc } = makeService({ payment: bigPayment, userSamePaymentCents: 0, userLastDayCents: 30_000 });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 9_999 }, manager)).rejects.toThrow(
      /en las últimas 24 h sumas 399,99 €/,
    );
  });

  it('el acumulado es de ESA persona, por la pasarela, pendiente o hecha (no fallidas ni del banco)', async () => {
    const { svc, prismaMock } = makeService({ payment: okPayment });
    await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager);
    const wheres = prismaMock.refund.aggregate.mock.calls
      .map(([arg]: [{ where: Record<string, unknown> }]) => arg.where)
      .filter((w: Record<string, unknown>) => 'requestedBy' in w);
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      expect(w).toMatchObject({
        tenantId: 't-1',
        requestedBy: 'u-1',
        registeredManually: false,
        status: { in: ['PENDING', 'SUCCEEDED'] },
      });
    }
    expect(wheres.some((w: Record<string, unknown>) => w.paymentId === 'pay-1')).toBe(true);
    expect(wheres.some((w: Record<string, unknown>) => 'createdAt' in w)).toBe(true);
  });

  it('se decide con candado por persona y la fila del cobro bloqueada (sin carreras entre peticiones suyas)', async () => {
    const { svc, prismaMock } = makeService({ payment: okPayment });
    await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager);
    const calls = (prismaMock as unknown as { $queryRaw: { mock: { calls: Array<[TemplateStringsArray, ...unknown[]]> } } })
      .$queryRaw.mock.calls;
    const userLock = calls.findIndex(([s, key]) => s.join('?').includes('pg_advisory_xact_lock') && key === 'refund-user:u-1');
    const rowLock = calls.findIndex(([s]) => s.join('?').includes('FOR UPDATE'));
    expect(userLock).toBeGreaterThanOrEqual(0);
    expect(rowLock).toBeGreaterThan(userLock);
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

  it('lo reservado por otras devoluciones pendientes cuenta: no se pasa de lo cobrado', async () => {
    const { svc, adapterMock, prismaMock } = makeService({ payment: okPayment, reservedCents: 4000 });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 1500 }, manager)).rejects.toThrow(
      /Solo quedan 1000 céntimos/,
    );
    expect(prismaMock.refund.create).not.toHaveBeenCalled();
    expect(adapterMock.refund).not.toHaveBeenCalled();
  });

  it('la reserva se hace con la fila del cobro bloqueada (FOR UPDATE)', async () => {
    const { svc, prismaMock } = makeService({ payment: okPayment });
    await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager);
    const sqls = (prismaMock as unknown as { $queryRaw: { mock: { calls: Array<[TemplateStringsArray]> } } }).$queryRaw.mock.calls.map(
      ([s]) => s.join('?'),
    );
    expect(sqls.some((s) => s.includes('FROM payments') && s.includes('FOR UPDATE'))).toBe(true);
  });

  it('sin pasarela para el proveedor → 409 antes de reservar nada', async () => {
    const { svc, gatewaysMock, prismaMock } = makeService({ payment: okPayment });
    gatewaysMock.get.mockImplementationOnce(() => {
      throw new Error('No gateway adapter for provider=WIPAY');
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(
      /No hay pasarela/,
    );
    expect(prismaMock.refund.create).not.toHaveBeenCalled();
  });
});

describe('RefundsService.refund — gateway interaction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rechazo explícito (FAILED) → FAILED (libera la reserva) + 409', async () => {
    const { svc, prismaMock, metricsMock, paymentsMock } = makeService({
      payment: okPayment,
      gatewayResult: { providerRefundId: 'gw-r-fail', status: 'FAILED' },
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(
      /rechazó la devolución/,
    );
    expect(prismaMock.refund.update).toHaveBeenCalledWith({
      where: { id: 'refund-1' },
      data: { status: 'FAILED', providerRefundId: 'gw-r-fail' },
    });
    expect(metricsMock.refundsCreated.inc).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(paymentsMock.transition).not.toHaveBeenCalled();
  });

  it('la pasarela no devuelve por API → FAILED + 409 que explica cómo hacerla', async () => {
    const { svc, prismaMock } = makeService({
      payment: okPayment,
      gatewayThrows: new Error('Redsys refund vía API no implementado. Refundea manualmente desde el panel del banco.'),
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(
      /Devolución hecha en el banco/,
    );
    expect(prismaMock.refund.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('conexión rechazada (la petición no salió) → FAILED + 409', async () => {
    const { svc, metricsMock } = makeService({
      payment: okPayment,
      gatewayThrows: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(
      /No se pudo hablar con la pasarela/,
    );
    expect(metricsMock.refundsCreated.inc).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('timeout (no sabemos si la hizo) → queda PENDING reservada, incidencia y 502; nunca FAILED', async () => {
    const { svc, prismaMock, auditMock, metricsMock, paymentsMock } = makeService({
      payment: okPayment,
      gatewayThrows: Object.assign(new Error('Timed out after 10000ms'), { code: 'ETIMEDOUT' }),
    });
    const err = await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as BadGatewayException).getResponse()).toMatchObject({
      code: 'REFUND_OUTCOME_UNKNOWN',
      refundId: 'refund-1',
    });
    expect(prismaMock.refund.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'refund.outcome_unknown',
        payload: expect.objectContaining({ refundId: 'refund-1', amountCents: 500 }),
      }),
    );
    expect(metricsMock.refundsCreated.inc).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' }));
    expect(paymentsMock.transition).not.toHaveBeenCalled();
  });

  it('la pasarela la deja PENDING → igual: reservada e incidencia, sin descontar aún', async () => {
    const { svc, prismaMock, paymentsMock } = makeService({
      payment: okPayment,
      gatewayResult: { providerRefundId: 'gw-r-p', status: 'PENDING' },
    });
    await expect(svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager)).rejects.toThrow(BadGatewayException);
    expect(prismaMock.refund.update).toHaveBeenCalledWith({ where: { id: 'refund-1' }, data: { providerRefundId: 'gw-r-p' } });
    expect(paymentsMock.transition).not.toHaveBeenCalled();
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
      expect.objectContaining({ prepare: expect.any(Function) }),
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
    expect(paymentsMock.applyRefundToEarning).toHaveBeenCalledWith('pay-1', 'refund-1', 1500);
  });

  it('SUCCEEDED se apunta DENTRO de la transacción del FSM (con el descuento), solo si sigue PENDING', async () => {
    const { svc, prismaMock } = makeService({ payment: okPayment });
    await svc.refund({ paymentId: 'pay-1', amountCents: 1500 }, manager);
    expect(prismaMock.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'refund-1', status: 'PENDING' },
      data: { status: 'SUCCEEDED', providerRefundId: 'gw-r-1' },
    });
    // Nunca un update suelto a SUCCEEDED fuera de esa transacción.
    expect(prismaMock.refund.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED' }) }),
    );
  });

  it('el FSM rechaza apuntarla tras devolver la pasarela → NO se traga: incidencia y 409, sigue PENDING', async () => {
    const { svc, paymentsMock, auditMock } = makeService({ payment: okPayment });
    paymentsMock.transition.mockRejectedValueOnce(
      new InvalidTransitionError('REFUNDED', 'REFUND_PARTIAL'),
    );
    const err = await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'REFUND_SETTLE_REJECTED' });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refund.settle_failed', payload: expect.objectContaining({ refundId: 'refund-1' }) }),
    );
    expect(paymentsMock.applyRefundToEarning).not.toHaveBeenCalled();
  });

  it('si falla el descuento a la chica: devolución hecha igualmente, con alerta (el repaso la reintenta)', async () => {
    const { svc, paymentsMock, auditMock, metricsMock } = makeService({ payment: okPayment });
    paymentsMock.applyRefundToEarning.mockRejectedValueOnce(new Error('deadlock'));
    const result = await svc.refund({ paymentId: 'pay-1', amountCents: 500 }, manager);
    expect(result.status).toBe('SUCCEEDED');
    expect(metricsMock.earningReversalFailed.inc).toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'refund.earning_reverse_failed' }));
  });
});

describe('RefundsService.registerBankRefund — devolución hecha en el portal de BBVA (Fase 1C)', () => {
  beforeEach(() => vi.clearAllMocks());

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
    // Ya SUCCEEDED y dentro de la transacción del FSM: o se apunta con el descuento o nada.
    expect(prismaMock.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.id,
        amountCents: 10_500,
        status: 'SUCCEEDED',
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
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(paymentsMock.applyRefundToEarning).toHaveBeenCalledWith('pay-1', result.id, 10_500);
    expect(auditMock.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'refund.bank_registered' }));
    expect(result).toMatchObject({ status: 'SUCCEEDED', providerRefundId: 'DEV-778812' });
  });

  it('cuenta lo que reservan las devoluciones en curso por la pasarela', async () => {
    const { svc, prismaMock, paymentsMock } = makeService({ payment: redsysPayment, reservedCents: 6000 });
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 5000, reason: 'motivo' }, owner),
    ).rejects.toThrow(/Solo quedan 4500 céntimos/);
    expect(prismaMock.refund.create).not.toHaveBeenCalled();
    expect(paymentsMock.applyRefundToEarning).not.toHaveBeenCalled();
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

  it('el cobro ya no admite la devolución (otra a la vez) → 409 y sin descontar a la chica (se deshace entera)', async () => {
    const { svc, paymentsMock } = makeService({ payment: redsysPayment });
    paymentsMock.transition.mockRejectedValueOnce(new InvalidTransitionError('PARTIALLY_REFUNDED', 'REFUND_PARTIAL'));
    await expect(
      svc.registerBankRefund({ paymentId: 'pay-1', amountCents: 5000, reason: 'motivo' }, owner),
    ).rejects.toThrow(/ya no admite esta devolución/);
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

describe('RefundsService.resolvePending — el dueño mira una devolución sin confirmar', () => {
  beforeEach(() => vi.clearAllMocks());

  const stale: RefundRowFixture = {
    id: 'refund-9',
    tenantId: 't-1',
    paymentId: 'pay-1',
    amountCents: 2500,
    status: 'PENDING',
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  };

  it('no hecha → FAILED (libera la reserva), sin tocar el cobro ni a la chica', async () => {
    const { svc, prismaMock, paymentsMock, auditMock } = makeService({ payment: okPayment, existingRefund: stale });
    const result = await svc.resolvePending(
      { paymentId: 'pay-1', refundId: 'refund-9', outcome: 'FAILED', note: 'No aparece en el portal' },
      owner,
    );
    expect(result).toMatchObject({ id: 'refund-9', status: 'FAILED' });
    expect(prismaMock.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'refund-9', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    expect(paymentsMock.transition).not.toHaveBeenCalled();
    expect(paymentsMock.applyRefundToEarning).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refund.pending_resolved', payload: expect.objectContaining({ outcome: 'FAILED' }) }),
    );
  });

  it('hecha → descuento del cobro + SUCCEEDED en la misma transacción y descuento a la chica', async () => {
    const { svc, prismaMock, paymentsMock } = makeService({ payment: okPayment, existingRefund: stale });
    await svc.resolvePending(
      { paymentId: 'pay-1', refundId: 'refund-9', outcome: 'SUCCEEDED', note: 'Sale en el portal' },
      owner,
    );
    expect(paymentsMock.transition).toHaveBeenCalledWith(
      'pay-1',
      { type: 'REFUND_PARTIAL', amountCents: 2500 },
      't-1',
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
    expect(prismaMock.refund.updateMany).toHaveBeenCalledWith({
      where: { id: 'refund-9', status: 'PENDING' },
      data: { status: 'SUCCEEDED' },
    });
    expect(paymentsMock.applyRefundToEarning).toHaveBeenCalledWith('pay-1', 'refund-9', 2500);
  });

  it('solo el dueño; otra devolución / otro local → 404; ya resuelta → 409; recién creada → 409', async () => {
    await expect(
      makeService({ existingRefund: stale }).svc.resolvePending(
        { paymentId: 'pay-1', refundId: 'refund-9', outcome: 'FAILED', note: 'x' },
        manager,
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      makeService({ existingRefund: { ...stale, tenantId: 't-otro' } }).svc.resolvePending(
        { paymentId: 'pay-1', refundId: 'refund-9', outcome: 'FAILED', note: 'x' },
        owner,
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      makeService({ existingRefund: { ...stale, status: 'SUCCEEDED' } }).svc.resolvePending(
        { paymentId: 'pay-1', refundId: 'refund-9', outcome: 'FAILED', note: 'x' },
        owner,
      ),
    ).rejects.toThrow(/ya no está pendiente/);
    await expect(
      makeService({ existingRefund: { ...stale, createdAt: new Date() } }).svc.resolvePending(
        { paymentId: 'pay-1', refundId: 'refund-9', outcome: 'FAILED', note: 'x' },
        owner,
      ),
    ).rejects.toThrow(/Espera un par de minutos/);
  });

  it('otra persona la resolvió a la vez → 409 (la transacción se deshace)', async () => {
    const { svc, prismaMock } = makeService({ payment: okPayment, existingRefund: stale });
    prismaMock.refund.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.resolvePending({ paymentId: 'pay-1', refundId: 'refund-9', outcome: 'FAILED', note: 'x' }, owner),
    ).rejects.toThrow(/ya no está pendiente/);
  });
});
