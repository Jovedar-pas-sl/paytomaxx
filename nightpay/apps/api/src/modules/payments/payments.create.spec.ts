import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { CreatePaymentDto } from '@nightpay/contracts';
import { PaymentsService } from './payments.service';

/**
 * create() con la base simulada: lo que se guarda al crear un cobro.
 */

const TERMINAL = { id: 'term-1', active: true, tenantId: 'tenant-1' };

interface Opts {
  provider?: string | null;
  capCents?: number;
  beneficiaryExists?: boolean;
}

function makeService(opts: Opts = {}) {
  const created: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
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
    paymentEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    terminal: {
      findUnique: vi.fn().mockResolvedValue(TERMINAL),
      findFirst: vi.fn().mockResolvedValue(TERMINAL),
    },
    venue: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        operatorMaxCobroCents: opts.capCents ?? 20_000,
        platformCommissionBps: 1000,
        operatorCommissionDefaults: null,
        walletGroup: null,
      }),
    },
    gatewayCredential: {
      findFirst: vi.fn().mockResolvedValue(opts.provider === null ? null : { provider: opts.provider ?? 'REDSYS' }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(opts.beneficiaryExists === false ? null : { id: 'user-2', commissionBps: null }),
    },
    clientWallet: { findFirst: vi.fn().mockResolvedValue({ id: 'wallet-1', status: 'ACTIVE' }) },
    serviceItem: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(async () => [{ id: 'wallet-new' }]),
  };
  const prisma = {
    ...db,
    asSystem: vi.fn(async (fn: (t: typeof db) => unknown) => fn(db)),
    $transaction: vi.fn(async (fn: (t: typeof db) => unknown) => fn(db)),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = Object.create(PaymentsService.prototype) as PaymentsService;
  Object.assign(service, {
    prisma,
    cls: { get: () => ({ traceId: 'trace-1' }) },
    logger,
    metrics: { paymentsCreated: { inc: vi.fn() } },
    qrExpireQueue: { add: vi.fn() },
    wallets: { createEmpty: vi.fn().mockResolvedValue({ id: 'wallet-new', qrToken: 'w' }) },
  });
  return { service, db, created, events, logger };
}

const operator = { userId: 'op-1', role: 'OPERATOR' };
const owner = { userId: 'owner-1', role: 'OWNER' };

function dto(extra: Partial<CreatePaymentDto> = {}): CreatePaymentDto {
  return { amountCents: 10_000, currency: 'EUR', terminalExternalId: 'BARRA-1', ...extra } as CreatePaymentDto;
}

describe('create — propina que pone quien crea el cobro (#3)', () => {
  it('Redsys, cobro con QR: se apunta y es devolvible (el banco la confirmará)', async () => {
    const { service, created } = makeService();
    await service.create('tenant-1', 'idem-key-0001', dto({ tipCents: 500 }), operator);
    expect(created[0]).toMatchObject({ tipCents: 500, availableAmountCents: 10_500, tipGoesTo: 'operator' });
  });

  it('otra pasarela: no se apunta (no la cobraría) y queda constancia', async () => {
    const { service, created, events } = makeService({ provider: 'PAYTEF' });
    await service.create('tenant-1', 'idem-key-0002', dto({ tipCents: 500, tipGoesTo: 'operator' }), operator);
    expect(created[0]).toMatchObject({ tipCents: 0, availableAmountCents: 10_000 });
    expect(created[0]).not.toHaveProperty('tipGoesTo');
    expect(events[0]?.payload).toMatchObject({ tipCents: 0, tipIgnoredCents: 500 });
  });

  it('cobro por datáfono externo o recarga de saldo: sin propina aunque sea Redsys', async () => {
    const pos = makeService();
    await pos.service.create('tenant-1', 'idem-key-0003', dto({ tipCents: 900, captureMethod: 'POS_EXTERNAL' }), owner);
    expect(pos.created[0]).toMatchObject({ tipCents: 0, availableAmountCents: 10_000 });

    const topUp = makeService();
    await topUp.service.create(
      'tenant-1',
      'idem-key-0004',
      dto({ tipCents: 900, wallet: { walletId: '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f' } }),
      owner,
    );
    expect(topUp.created[0]).toMatchObject({ tipCents: 0, availableAmountCents: 10_000 });
  });

  it('como mucho el importe y 500 €', async () => {
    const { service } = makeService();
    await expect(service.create('tenant-1', 'idem-key-0005', dto({ amountCents: 2_000, tipCents: 2_001 }), owner)).rejects.toThrow(
      /no puede pasar del importe/,
    );
    await expect(
      service.create('tenant-1', 'idem-key-0006', dto({ amountCents: 900_000, tipCents: 50_001 }), owner),
    ).rejects.toThrow(BadRequestException);
  });

  it('el tope del local para la chica cuenta importe + propina', async () => {
    const { service, created } = makeService({ capCents: 20_000 });
    await expect(
      service.create('tenant-1', 'idem-key-0007', dto({ amountCents: 18_000, tipCents: 3_000 }), operator),
    ).rejects.toThrow(/con propina\) supera el límite del local/);
    expect(created).toHaveLength(0);
  });
});

describe('create — destino de la propina (#53)', () => {
  it('la chica no puede dar la propina a otra persona (se perdería)', async () => {
    const { service, created } = makeService();
    await expect(
      service.create(
        'tenant-1',
        'idem-key-0008',
        dto({ tipCents: 500, tipGoesTo: 'beneficiary', tipBeneficiaryUserId: '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f' }),
        operator,
      ),
    ).rejects.toThrow(/para ti o para el local/);
    await expect(service.create('tenant-1', 'idem-key-0009', dto({ tipGoesTo: 'shared' }), operator)).rejects.toThrow(
      BadRequestException,
    );
    expect(created).toHaveLength(0);
  });

  it('la chica puede darla al local', async () => {
    const { service, created } = makeService();
    await service.create('tenant-1', 'idem-key-0010', dto({ tipCents: 500, tipGoesTo: 'venue' }), operator);
    expect(created[0]).toMatchObject({ tipCents: 500, tipGoesTo: 'venue' });
  });

  it('el dueño sí puede dársela a una chica del local', async () => {
    const { service, created } = makeService();
    await service.create(
      'tenant-1',
      'idem-key-0011',
      dto({ tipCents: 500, tipGoesTo: 'beneficiary', tipBeneficiaryUserId: '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f' }),
      owner,
    );
    expect(created[0]).toMatchObject({
      tipCents: 500,
      tipGoesTo: 'beneficiary',
      tipBeneficiaryUserId: '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f',
    });
  });
});
