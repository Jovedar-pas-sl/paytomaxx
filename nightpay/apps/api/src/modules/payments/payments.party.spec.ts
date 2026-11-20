import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreatePaymentDto } from '@nightpay/contracts';
import { PaymentsService } from './payments.service';

/**
 * OxioParty en create() con la base simulada: el cobro (y su cobro del saldo
 * enlazado) lleva la caseta de quien cobra; la recarga no; con la fiesta
 * terminada, 423 EVENT_ENDED sin guardar nada. Con OxioPay (club) nada de esto:
 * ni se mira la caseta ni la fecha de fin, y lo guardado es lo de siempre.
 */

const TERMINAL = { id: 'term-1', active: true, tenantId: 'tenant-1' };
const STALL = '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f';

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeService(opts: { eventEndsAt?: Date | null } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const saldoCharges: Array<Record<string, unknown>> = [];
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
        currency: 'EUR',
        status: 'CREATED',
        qrToken: 'qr-1',
        qrExpiresAt: new Date(),
        createdAt: new Date(),
        captureMethod: created[0]?.captureMethod ?? null,
        walletId: created[0]?.walletId ?? null,
        wallet: null,
      })),
    },
    walletChargeRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        saldoCharges.push(data);
        return { id: 'saldo-1' };
      }),
      findUnique: vi.fn().mockResolvedValue({ id: 'saldo-1', payToken: 'tok', status: 'PENDING' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'saldo-1', payToken: 'tok', status: 'PENDING' }),
    },
    paymentEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    terminal: { findUnique: vi.fn().mockResolvedValue(TERMINAL), findFirst: vi.fn().mockResolvedValue(TERMINAL) },
    venue: {
      // La fecha de fin (OxioParty) o lo que cobra cada puesto y las secciones (de fábrica).
      findUnique: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
        select.eventEndsAt ? { eventEndsAt: opts.eventEndsAt ?? null } : { postRules: null, sections: null },
      ),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        operatorMaxCobroCents: 20_000,
        platformCommissionBps: 1000,
        operatorCommissionDefaults: null,
        walletGroup: null,
        pausedAt: null,
        business: null,
        paymentMethods: { pos: true },
      }),
    },
    gatewayCredential: { findFirst: vi.fn().mockResolvedValue({ provider: 'REDSYS' }) },
    user: {
      // La caseta de quien cobra (OxioParty); el resto (puesto, comisión), lo de siempre.
      findFirst: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
        select.stallId ? { stallId: STALL } : { id: 'user-2', commissionBps: null, post: null },
      ),
    },
    clientWallet: { findFirst: vi.fn().mockResolvedValue({ id: 'wallet-1', status: 'ACTIVE' }) },
    serviceItem: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    paymentLine: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    chargeRefCounter: { upsert: vi.fn().mockResolvedValue({ lastRef: 12 }) },
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
  return { service, db, created, saldoCharges };
}

const waiter = { userId: 'waiter-1', role: 'WAITER' };
const owner = { userId: 'owner-1', role: 'OWNER' };
const cobro = (extra: Partial<CreatePaymentDto> = {}) =>
  ({ amountCents: 1_000, currency: 'EUR', terminalExternalId: 'BARRA-1', revenueCategory: 'VENUE_BAR', ...extra }) as CreatePaymentDto;
const askedForStall = (db: ReturnType<typeof makeService>['db']) =>
  db.user.findFirst.mock.calls.some(([q]) => Boolean((q as { select: Record<string, unknown> }).select.stallId));
const askedForEnd = (db: ReturnType<typeof makeService>['db']) =>
  db.venue.findUnique.mock.calls.some(([q]) => Boolean((q as { select: Record<string, unknown> }).select.eventEndsAt));

describe('create — OxioPay (club): nada cambia', () => {
  it('ni se mira la caseta ni el fin de la fiesta, y el cobro no lleva stallId', async () => {
    const { service, db, created, saldoCharges } = makeService({ eventEndsAt: new Date(Date.now() - 60_000) });
    await service.create('tenant-1', 'idem-club-0001', cobro({ withSaldo: true }), waiter);
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('stallId');
    expect(saldoCharges[0]).not.toHaveProperty('stallId');
    expect(askedForStall(db)).toBe(false);
    expect(askedForEnd(db)).toBe(false);
  });
});

describe('create — OxioParty (party)', () => {
  it('el cobro y su cobro del saldo enlazado llevan la caseta de quien cobra', async () => {
    vi.stubEnv('EDITION', 'party');
    const { service, db, created, saldoCharges } = makeService({ eventEndsAt: new Date(Date.now() + 3_600_000) });
    await service.create('tenant-1', 'idem-party-0001', cobro({ withSaldo: true }), waiter);
    expect(created[0]).toMatchObject({ stallId: STALL });
    expect(saldoCharges[0]).toMatchObject({ stallId: STALL, linkedPaymentId: 'pay-1' });
    expect(db.user.findFirst).toHaveBeenCalledWith({ where: { id: 'waiter-1', tenantId: 'tenant-1' }, select: { stallId: true } });
  });

  it('una recarga no es venta de ninguna caseta: sin stallId', async () => {
    vi.stubEnv('EDITION', 'party');
    const { service, db, created } = makeService();
    await service.create('tenant-1', 'idem-party-0002', { amountCents: 2_000, currency: 'EUR', terminalExternalId: 'BARRA-1', wallet: { walletId: STALL } } as CreatePaymentDto, owner);
    expect(created[0]).toMatchObject({ captureMethod: 'WALLET_TOPUP' });
    expect(created[0]).not.toHaveProperty('stallId');
    expect(askedForStall(db)).toBe(false);
  });

  it('con la fiesta terminada: 423 EVENT_ENDED (cobros y recargas) y no se guarda nada', async () => {
    vi.stubEnv('EDITION', 'party');
    for (const [i, extra] of [{}, { wallet: { walletId: STALL } }].entries()) {
      const { service, created } = makeService({ eventEndsAt: new Date(Date.now() - 60_000) });
      await expect(service.create('tenant-1', `idem-party-001${i}`, cobro(extra as Partial<CreatePaymentDto>), owner)).rejects.toMatchObject({
        status: 423,
        response: expect.objectContaining({ code: 'EVENT_ENDED' }),
      });
      expect(created).toHaveLength(0);
    }
  });
});
