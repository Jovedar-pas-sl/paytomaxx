import { describe, it, expect, vi } from 'vitest';
import type { CreatePaymentDto } from '@nightpay/contracts';
import { PaymentsService } from './payments.service';
import { settleChargedTip } from './tip';
import { chargedCentsOf, refundableFeeCents, venueServiceFeeOf } from './service-fee';

/**
 * «Comisión del servicio»: con el interruptor del local encendido, el cobro
 * guarda el % y el importe del momento, la pasarela cobra importe + comisión
 * + propina, y el local ya no paga el % antiguo. Apagado, como siempre.
 */

interface Fee {
  enabled: boolean;
  cardBps?: number;
  topUpBps?: number;
}

function makeService(fee: Fee) {
  const created: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const terminal = { id: 'term-1', active: true, tenantId: 'tenant-1' };
  const db = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'pay-1', ...data };
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        id: 'pay-1',
        amountCents: created[0]?.amountCents ?? 0,
        serviceFeeCents: created[0]?.serviceFeeCents ?? 0,
        serviceFeeBps: created[0]?.serviceFeeBps ?? null,
        currency: 'EUR',
        status: 'CREATED',
        qrToken: 'qr-1',
        qrExpiresAt: new Date(),
        createdAt: new Date(),
        captureMethod: created[0]?.captureMethod ?? null,
        walletId: created[0]?.walletId ?? null,
        linkedWalletCharge: null,
      })),
    },
    paymentEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    terminal: { findUnique: vi.fn().mockResolvedValue(terminal), findFirst: vi.fn().mockResolvedValue(terminal) },
    venue: {
      findUnique: vi.fn().mockResolvedValue({ postRules: null, sections: null }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        operatorMaxCobroCents: 20_000,
        platformCommissionBps: 1000,
        operatorCommissionDefaults: null,
        walletGroup: null,
        pausedAt: null,
        business: null,
        // Cobra también por datáfono: lo guardó encendido (de fábrica va apagado).
        paymentMethods: { pos: true },
        serviceFeeEnabled: fee.enabled,
        serviceFeeBps: fee.cardBps ?? 1000,
        topUpServiceFeeBps: fee.topUpBps ?? 1000,
      }),
    },
    gatewayCredential: { findFirst: vi.fn().mockResolvedValue({ provider: 'REDSYS' }) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-2', commissionBps: null }) },
    clientWallet: { findFirst: vi.fn().mockResolvedValue({ id: 'wallet-1', status: 'ACTIVE' }) },
    serviceItem: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    paymentLine: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    chargeRefCounter: { upsert: vi.fn().mockResolvedValue({ lastRef: 7 }) },
    $queryRaw: vi.fn(async () => [{ id: 'wallet-new' }]),
  };
  const prisma = {
    ...db,
    asSystem: vi.fn(async (fn: (t: typeof db) => unknown) => fn(db)),
    $transaction: vi.fn(async (fn: (t: typeof db) => unknown) => fn(db)),
  };
  const service = Object.create(PaymentsService.prototype) as PaymentsService;
  Object.assign(service, {
    prisma,
    cls: { get: () => ({ traceId: 'trace-1' }) },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { paymentsCreated: { inc: vi.fn() } },
    qrExpireQueue: { add: vi.fn() },
  });
  return { service, created, events };
}

const owner = { userId: 'owner-1', role: 'OWNER' };
const dto = (extra: Partial<CreatePaymentDto> = {}): CreatePaymentDto =>
  ({ amountCents: 3300, currency: 'EUR', terminalExternalId: 'BARRA-1', ...extra }) as CreatePaymentDto;
const TOP_UP = { wallet: { walletId: '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f' } } as const;

describe('crear un cobro con la comisión del servicio', () => {
  it('apagada: como siempre (sin %, 0 €, el % antiguo de OxioPay y lo devolvible de siempre)', async () => {
    const { service, created } = makeService({ enabled: false });
    // Sin propina al crear (B1: la elige el cliente al pagar).
    const res = await service.create('tenant-1', 'idem-fee-0001', dto(), owner);
    expect(created[0]).toMatchObject({
      amountCents: 3300,
      tipCents: 0,
      availableAmountCents: 3300,
      serviceFeeBps: null,
      serviceFeeCents: 0,
      platformCommissionBps: 1000,
    });
    expect(res).toMatchObject({ amountCents: 3300, serviceFeeCents: 0, serviceFeeBps: null });
  });

  it('encendida, pago directo: 33 € → 3,30 €, devolvible entera y el local ya no paga el % antiguo', async () => {
    const { service, created, events } = makeService({ enabled: true, cardBps: 1000, topUpBps: 1200 });
    const res = await service.create('tenant-1', 'idem-fee-0002', dto(), owner);
    expect(created[0]).toMatchObject({
      amountCents: 3300,
      tipCents: 0,
      serviceFeeBps: 1000,
      serviceFeeCents: 330,
      availableAmountCents: 3630,
      platformCommissionBps: 0,
    });
    expect(events[0]?.payload).toMatchObject({ amountCents: 3300, serviceFeeCents: 330 });
    expect(res).toMatchObject({ amountCents: 3300, serviceFeeCents: 330, serviceFeeBps: 1000 });
  });

  it('encendida, datáfono: también lleva comisión (cualquier pago con tarjeta)', async () => {
    const { service, created } = makeService({ enabled: true, cardBps: 800 });
    await service.create('tenant-1', 'idem-fee-0003', dto({ captureMethod: 'POS_EXTERNAL' }), owner);
    expect(created[0]).toMatchObject({ serviceFeeBps: 800, serviceFeeCents: 264, availableAmountCents: 3564 });
  });

  it('encendida, recarga al 12 %: 50 € → 6 €, el saldo es 50 € y la comisión no se devuelve', async () => {
    const { service, created } = makeService({ enabled: true, cardBps: 1000, topUpBps: 1200 });
    const res = await service.create('tenant-1', 'idem-fee-0004', dto({ amountCents: 5000, ...TOP_UP }), owner);
    expect(created[0]).toMatchObject({ amountCents: 5000, serviceFeeBps: 1200, serviceFeeCents: 600, availableAmountCents: 5000 });
    expect(res).toMatchObject({ amountCents: 5000, serviceFeeCents: 600 });
  });

  it('encendida al 0 %: modelo nuevo sin comisión (ni el % antiguo)', async () => {
    const { service, created } = makeService({ enabled: true, cardBps: 0 });
    await service.create('tenant-1', 'idem-fee-0005', dto(), owner);
    expect(created[0]).toMatchObject({ serviceFeeBps: 0, serviceFeeCents: 0, platformCommissionBps: 0, availableAmountCents: 3300 });
  });
});

describe('pasarela: importe + comisión del servicio + propina', () => {
  it('openCheckout manda al banco 38,30 € (33 + 3,30 + 2) y lo guarda en el intento', async () => {
    const authorize = vi.fn(async () => ({ providerTxId: 'ORD1' }));
    const service = Object.create(PaymentsService.prototype) as PaymentsService;
    Object.assign(service, { gateways: { get: () => ({ authorize }) } });
    const opened = await (
      service as unknown as {
        openCheckout: (p: unknown, provider: string, choice: unknown) => Promise<{ chargeCents: number; tipCents: number | null }>;
      }
    ).openCheckout(
      { id: 'p1', tenantId: 't1', amountCents: 3300, serviceFeeCents: 330, tipCents: 0, currency: 'EUR' },
      'REDSYS',
      { tipCents: 200, method: 'card', language: 'es' },
    );
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 3830 }));
    expect(opened).toMatchObject({ chargeCents: 3830, tipCents: 200 });
  });

  it('otra pasarela (sin propina): importe + comisión', async () => {
    const authorize = vi.fn(async () => ({ providerTxId: 'PT1' }));
    const service = Object.create(PaymentsService.prototype) as PaymentsService;
    Object.assign(service, { gateways: { get: () => ({ authorize }) } });
    await (service as unknown as { openCheckout: (p: unknown, provider: string) => Promise<unknown> }).openCheckout(
      { id: 'p1', tenantId: 't1', amountCents: 5000, serviceFeeCents: 600, tipCents: 0, currency: 'EUR' },
      'PAYTEF',
    );
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5600 }));
  });
});

describe('al pagarse, lo devolvible', () => {
  it('con la propina del banco: importe + comisión + propina', () => {
    expect(settleChargedTip({ amountCents: 3300, tipCents: 200, tipGoesTo: null, creatorRole: 'OPERATOR', serviceFeeCents: 330 })).toEqual({
      tipCents: 200,
      availableAmountCents: 3830,
      tipGoesTo: 'operator',
    });
  });

  it('sin propina: importe + comisión; sin comisión, como siempre', () => {
    expect(settleChargedTip({ amountCents: 3300, tipCents: 0, tipGoesTo: null, creatorRole: null, serviceFeeCents: 330 })).toEqual({
      tipCents: 0,
      availableAmountCents: 3630,
      tipGoesTo: null,
    });
    expect(settleChargedTip({ amountCents: 3300, tipCents: 0, tipGoesTo: null, creatorRole: null })).toMatchObject({ availableAmountCents: 3300 });
  });
});

describe('cuentas del cobro', () => {
  it('lo cobrado y lo devolvible de la comisión', () => {
    expect(chargedCentsOf({ amountCents: 3300, serviceFeeCents: 330, tipCents: 200 })).toBe(3830);
    expect(chargedCentsOf({ amountCents: 3300, tipCents: 200 })).toBe(3500);
    expect(refundableFeeCents({ walletId: null, serviceFeeCents: 330 })).toBe(330);
    expect(refundableFeeCents({ walletId: 'w1', serviceFeeCents: 600 })).toBe(0);
  });

  it('el local: apagado de fábrica, y sus %', () => {
    expect(venueServiceFeeOf(null).enabled).toBe(false);
    expect(venueServiceFeeOf({ serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1200 })).toEqual({
      enabled: true,
      cardBps: 1000,
      topUpBps: 1200,
    });
  });
});
