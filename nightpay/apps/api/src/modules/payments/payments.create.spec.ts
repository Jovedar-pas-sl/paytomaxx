import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
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
  /** Local en pausa (consola del super-admin). */
  pausedAt?: Date | null;
  businessStatus?: 'ACTIVE' | 'PAUSED';
  /** Formas de cobro del local (Ajustes); null = las de siempre. */
  paymentMethods?: Record<string, unknown> | null;
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
      // Qué cobra cada puesto y las secciones del local: los de fábrica.
      findUnique: vi.fn().mockResolvedValue({ postRules: null, sections: null }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        operatorMaxCobroCents: opts.capCents ?? 20_000,
        platformCommissionBps: 1000,
        operatorCommissionDefaults: null,
        walletGroup: null,
        pausedAt: opts.pausedAt ?? null,
        business: opts.businessStatus ? { status: opts.businessStatus } : null,
        paymentMethods: opts.paymentMethods ?? null,
      }),
    },
    gatewayCredential: {
      findFirst: vi.fn().mockResolvedValue(opts.provider === null ? null : { provider: opts.provider ?? 'REDSYS' }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(opts.beneficiaryExists === false ? null : { id: 'user-2', commissionBps: null }),
    },
    clientWallet: { findFirst: vi.fn().mockResolvedValue({ id: 'wallet-1', status: 'ACTIVE' }) },
    serviceItem: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    // El mapa del dinero: líneas del cobro y su referencia (C-0001).
    paymentLine: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    chargeRefCounter: { upsert: vi.fn().mockResolvedValue({ lastRef: 12 }) },
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

describe('create — Idempotency-Key ligada a quién y a qué (#32)', () => {
  const body = dto({ amountCents: 4_000 });

  it('la misma petición repetida → el mismo cobro, sin crear otro', async () => {
    const first = makeService();
    await first.service.create('tenant-1', 'idem-key-0100', body, operator);
    const hash = first.created[0]!.idempotencyHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const again = makeService();
    again.db.payment.findUnique.mockResolvedValueOnce({ id: 'pay-1', idempotencyHash: hash, createdByUserId: 'op-1' });
    await expect(again.service.create('tenant-1', 'idem-key-0100', body, operator)).resolves.toMatchObject({ id: 'pay-1' });
    expect(again.created).toHaveLength(0);
  });

  it('la misma clave con otra persona o con otros datos → 409 (no se entrega el cobro de otro)', async () => {
    const first = makeService();
    await first.service.create('tenant-1', 'idem-key-0101', body, operator);
    const stored = { id: 'pay-1', idempotencyHash: first.created[0]!.idempotencyHash, createdByUserId: 'op-1' };

    const otherUser = makeService();
    otherUser.db.payment.findUnique.mockResolvedValueOnce(stored);
    await expect(otherUser.service.create('tenant-1', 'idem-key-0101', body, owner)).rejects.toThrow(ConflictException);

    const otherBody = makeService();
    otherBody.db.payment.findUnique.mockResolvedValueOnce(stored);
    await expect(
      otherBody.service.create('tenant-1', 'idem-key-0101', dto({ amountCents: 9_999 }), operator),
    ).rejects.toThrow(/ya se usó para otro cobro/);
    expect(otherBody.created).toHaveLength(0);
  });

  it('cobro de antes de guardar la huella: solo lo recibe quien lo creó', async () => {
    const legacy = { id: 'pay-1', idempotencyHash: null, createdByUserId: 'op-1' };
    const mine = makeService();
    mine.db.payment.findUnique.mockResolvedValueOnce(legacy);
    await expect(mine.service.create('tenant-1', 'idem-key-0102', body, operator)).resolves.toMatchObject({ id: 'pay-1' });
    const theirs = makeService();
    theirs.db.payment.findUnique.mockResolvedValueOnce(legacy);
    await expect(theirs.service.create('tenant-1', 'idem-key-0102', body, owner)).rejects.toThrow(ConflictException);
  });

  it('dos peticiones a la vez con la misma clave: la que pierde devuelve el cobro de la otra (no un 500)', async () => {
    const { service, db } = makeService();
    const winnerHash = await (async () => {
      const w = makeService();
      await w.service.create('tenant-1', 'idem-key-0103', body, operator);
      return w.created[0]!.idempotencyHash;
    })();
    db.payment.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['tenantId', 'idempotencyKey'] },
      }),
    );
    db.payment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pay-1', idempotencyHash: winnerHash, createdByUserId: 'op-1' });
    await expect(service.create('tenant-1', 'idem-key-0103', body, operator)).resolves.toMatchObject({ id: 'pay-1' });
  });

  it('recarga que crea saldo: el saldo se crea en la misma transacción que el cobro', async () => {
    const { service, db, created } = makeService();
    await service.create('tenant-1', 'idem-key-0104', dto({ wallet: { create: true, identifier: 'mesa 4' } }), owner);
    const insert = db.$queryRaw.mock.calls[0]!;
    expect((insert[0] as unknown as string[]).join('?')).toContain('INSERT INTO client_wallets');
    expect((insert[0] as unknown as string[]).join('?')).toContain('ON CONFLICT ("shortCode")');
    expect(created[0]).toMatchObject({ walletId: 'wallet-new', captureMethod: 'WALLET_TOPUP' });
    // Todo dentro de UNA transacción del sistema: si el cobro falla, el saldo tampoco queda.
    expect(db.$queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(db.payment.create.mock.invocationCallOrder[0]!);
  });

  it('recarga de un saldo que existe: activo o a cero (DEPLETED) sí; sumado a otro o cerrado, no', async () => {
    const walletId = '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f';
    for (const wallet of [{ status: 'ACTIVE', mergedIntoId: null }, { status: 'DEPLETED', mergedIntoId: null }]) {
      const { service, db, created } = makeService();
      db.clientWallet.findFirst.mockResolvedValueOnce({ id: walletId, ...wallet });
      await service.create('tenant-1', 'idem-key-0110', dto({ wallet: { walletId } }), owner);
      expect(created[0]).toMatchObject({ walletId, captureMethod: 'WALLET_TOPUP', revenueCategory: 'EXTRA', tipCents: 0 });
    }
    for (const wallet of [{ status: 'DEPLETED', mergedIntoId: 'w-2' }, { status: 'REFUNDED', mergedIntoId: null }, { status: 'EXPIRED', mergedIntoId: null }]) {
      const { service, db, created } = makeService();
      db.clientWallet.findFirst.mockResolvedValueOnce({ id: walletId, ...wallet });
      await expect(service.create('tenant-1', 'idem-key-0111', dto({ wallet: { walletId } }), owner)).rejects.toThrow(
        BadRequestException,
      );
      expect(created).toHaveLength(0);
    }
  });

  it('código corto ya cogido por otro saldo activo → prueba otro sin romper la transacción', async () => {
    const { service, db, created } = makeService();
    db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'wallet-2' }]);
    await service.create('tenant-1', 'idem-key-0105', dto({ wallet: { create: true } }), owner);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(created[0]).toMatchObject({ walletId: 'wallet-2' });
  });

  it('recarga por datáfono externo → 400 antes de crear nada', async () => {
    const { service, db, created } = makeService();
    await expect(
      service.create('tenant-1', 'idem-key-0106', dto({ wallet: { create: true }, captureMethod: 'POS_EXTERNAL' }), owner),
    ).rejects.toThrow('No se puede recargar el saldo con un datáfono externo: usa el QR.');
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

describe('create — el % de la chica se fija al crear el cobro (#54)', () => {
  it('cobro de la chica: su % de ahora (o el del local) queda guardado', async () => {
    const own = makeService();
    // La misma persona se lee dos veces: su puesto (sección por defecto) y su %.
    own.db.user.findFirst.mockResolvedValue({ id: 'op-1', commissionBps: 7_000, post: null });
    await own.service.create('tenant-1', 'idem-key-0200', dto(), operator);
    expect(own.created[0]).toMatchObject({ operatorCommissionBps: 7_000, revenueCategory: 'CHICA_SERVICE' });

    const venueDefault = makeService();
    venueDefault.db.user.findFirst.mockResolvedValueOnce({ id: 'op-1', commissionBps: null });
    await venueDefault.service.create('tenant-1', 'idem-key-0201', dto(), operator);
    expect(venueDefault.created[0]).toMatchObject({ operatorCommissionBps: 9_000 });
  });

  it('cobros del local y recargas de saldo: sin % fijado', async () => {
    const byOwner = makeService();
    await byOwner.service.create('tenant-1', 'idem-key-0202', dto({ revenueCategory: 'VENUE_BAR' }), owner);
    expect(byOwner.created[0]).toMatchObject({ operatorCommissionBps: null });

    const topUp = makeService();
    await topUp.service.create('tenant-1', 'idem-key-0203', dto({ wallet: { create: true } }), owner);
    expect(topUp.created[0]).toMatchObject({ operatorCommissionBps: null });
  });
});

describe('create — local o negocio en pausa (consola del super-admin)', () => {
  it('local en pausa: 423 VENUE_PAUSED y no se guarda nada (cobro ni recarga)', async () => {
    const paused = makeService({ pausedAt: new Date() });
    await expect(paused.service.create('tenant-1', 'idem-key-0300', dto(), owner)).rejects.toMatchObject({
      status: 423,
      response: expect.objectContaining({ code: 'VENUE_PAUSED', pausedBy: 'venue' }),
    });
    await expect(
      paused.service.create('tenant-1', 'idem-key-0301', dto({ wallet: { create: true } }), operator),
    ).rejects.toMatchObject({ status: 423 });
    expect(paused.created).toHaveLength(0);
  });

  it('negocio en pausa: también 423 (pausedBy business)', async () => {
    const paused = makeService({ businessStatus: 'PAUSED' });
    await expect(paused.service.create('tenant-1', 'idem-key-0302', dto(), owner)).rejects.toMatchObject({
      status: 423,
      response: expect.objectContaining({ code: 'VENUE_PAUSED', pausedBy: 'business' }),
    });
    expect(paused.created).toHaveLength(0);
  });

  it('negocio activo y local sin pausa: se cobra como siempre', async () => {
    const active = makeService({ businessStatus: 'ACTIVE' });
    await active.service.create('tenant-1', 'idem-key-0303', dto(), owner);
    expect(active.created).toHaveLength(1);
  });
});

describe('create — formas de cobro del local (Ajustes → Formas de cobro)', () => {
  const disabled = (method: string) =>
    expect.objectContaining({ status: 409, response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED', method }) });

  it('QR con tarjeta apagado: 409 y no se guarda nada; el datáfono sigue', async () => {
    const off = makeService({ paymentMethods: { card: false } });
    await expect(off.service.create('tenant-1', 'idem-key-0400', dto(), owner)).rejects.toEqual(disabled('card'));
    expect(off.created).toHaveLength(0);
    await off.service.create('tenant-1', 'idem-key-0401', dto({ captureMethod: 'POS_EXTERNAL' }), owner);
    expect(off.created).toHaveLength(1);
  });

  it('datáfono apagado: 409 al crear un cobro POS', async () => {
    const off = makeService({ paymentMethods: { pos: false } });
    await expect(off.service.create('tenant-1', 'idem-key-0402', dto({ captureMethod: 'POS_EXTERNAL' }), owner)).rejects.toEqual(
      disabled('pos'),
    );
  });

  it('saldo apagado: una recarga (que se paga con tarjeta) tampoco se crea', async () => {
    const off = makeService({ paymentMethods: { wallet: false } });
    await expect(off.service.create('tenant-1', 'idem-key-0403', dto({ wallet: { create: true } }), operator)).rejects.toEqual(
      disabled('wallet'),
    );
    expect(off.created).toHaveLength(0);
  });

  it('propinas apagadas: una propina al crear → 409 TIPS_DISABLED; sin propina, se cobra', async () => {
    const off = makeService({ paymentMethods: { tips: false } });
    await expect(off.service.create('tenant-1', 'idem-key-0404', dto({ tipCents: 500 }), operator)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'TIPS_DISABLED' }),
    });
    await off.service.create('tenant-1', 'idem-key-0405', dto(), operator);
    expect(off.created).toHaveLength(1);
  });

  it('sin ajustes guardados: todo encendido, como antes', async () => {
    const all = makeService({ paymentMethods: null });
    await all.service.create('tenant-1', 'idem-key-0406', dto({ tipCents: 500 }), operator);
    await all.service.create('tenant-1', 'idem-key-0407', dto({ captureMethod: 'POS_EXTERNAL' }), owner);
    expect(all.created).toHaveLength(2);
  });
});
