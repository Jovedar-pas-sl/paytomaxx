import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import type { CreatePaymentDto } from '@nightpay/contracts';
import { PaymentsService } from './payments.service';

/**
 * create(): validaciones antes de guardar (datáfono, carta, saldo, propina),
 * caducidad y QR del cobro, y choques de la base que no son la Idempotency-Key.
 */

const NOW = new Date('2026-10-17T01:30:00+02:00');
const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const TERMINAL = 'f0e1d2c3-b4a5-4968-8776-655443322110';
const ZONE_TERMINAL = 'a9b8c7d6-e5f4-4a3b-8c2d-1e0f9a8b7c6d';
const SERVICE_ITEM = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const WALLET = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const BENEFICIARY = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

type Row = Record<string, unknown>;

interface Opts {
  terminal?: Row | null;
  zoneTerminal?: Row | null;
  serviceItem?: Row | null;
  wallet?: Row | null;
  /** Resultado del INSERT de un saldo nuevo ([] = código corto ocupado). */
  walletInsert?: Array<{ id: string }>;
  beneficiaryExists?: boolean;
  createError?: Error;
}

function makeService(opts: Opts = {}) {
  const created: Row[] = [];
  const db = {
    payment: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (opts.createError) throw opts.createError;
        created.push(data);
        return { id: PAYMENT_ID, amountCents: data.amountCents };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ id: PAYMENT_ID, createdAt: NOW, walletId: null, ...created[0] })),
    },
    paymentEvent: { create: vi.fn(async () => ({})) },
    terminal: {
      findUnique: vi.fn(async () => (opts.terminal === undefined ? { id: TERMINAL, active: true } : opts.terminal)),
      findFirst: vi.fn(async () => (opts.zoneTerminal === undefined ? { id: ZONE_TERMINAL } : opts.zoneTerminal)),
    },
    venue: {
      // Qué cobra cada puesto y las secciones del local: los de fábrica.
      findUnique: vi.fn(async () => ({ postRules: null, sections: null })),
      findUniqueOrThrow: vi.fn(async () => ({
        operatorMaxCobroCents: 20_000,
        platformCommissionBps: 1_000,
        operatorCommissionDefaults: null,
        walletGroup: 'grupo-bambu',
        pausedAt: null,
        business: null,
      })),
    },
    gatewayCredential: { findFirst: vi.fn(async () => ({ provider: 'REDSYS' })) },
    user: {
      findFirst: vi.fn(async () => (opts.beneficiaryExists === false ? null : { id: BENEFICIARY, commissionBps: null })),
    },
    clientWallet: { findFirst: vi.fn(async () => (opts.wallet === undefined ? { id: WALLET, status: 'ACTIVE' } : opts.wallet)) },
    serviceItem: {
      findFirst: vi.fn(async () => opts.serviceItem ?? null),
      findMany: vi.fn(async () => (opts.serviceItem ? [{ components: null, ...opts.serviceItem }] : [])),
    },
    // El mapa del dinero: líneas del cobro y su referencia (C-0001).
    paymentLine: { createMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
    chargeRefCounter: { upsert: vi.fn(async () => ({ lastRef: 3 })) },
    $queryRaw: vi.fn(async () => opts.walletInsert ?? [{ id: WALLET }]),
  };
  const prisma = { ...db, asSystem: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) };
  const qrQueue = { add: vi.fn(async () => ({})) };
  const metrics = { paymentsCreated: { inc: vi.fn() } };
  const service = new PaymentsService(
    prisma as never,
    { get: () => ({ traceId: 'trace-create-1' }) } as never,
    qrQueue as never,
    {} as never,
    {} as never,
    {} as never,
    metrics as never,
    {} as never,
    {} as never,
  );
  Object.assign(service, { logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  return { service, db, created, qrQueue, metrics };
}

const owner = { userId: 'c0ffee00-1234-4abc-8def-0123456789ab', role: 'OWNER' };
const waiter = { userId: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a', role: 'WAITER' };
const operator = { userId: 'a7b6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d', role: 'OPERATOR' };

function dto(extra: Partial<CreatePaymentDto> = {}): CreatePaymentDto {
  return { amountCents: 4_500, currency: 'EUR', terminalExternalId: 'BARRA-1', ...extra } as CreatePaymentDto;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('create — datáfono del cobro', () => {
  it('datáfono inexistente o dado de baja → 400 sin crear nada', async () => {
    const off = makeService({ terminal: { id: TERMINAL, active: false } });
    await expect(off.service.create(TENANT, 'idem-val-0001', dto(), owner)).rejects.toThrow(/BARRA-1/);
    const none = makeService({ terminal: null });
    await expect(none.service.create(TENANT, 'idem-val-0002', dto(), owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(off.created).toHaveLength(0);
    expect(none.created).toHaveLength(0);
  });

  it('por zona «OTRO» con nombre libre → zona normalizada y un datáfono activo de ese local', async () => {
    const { service, db, created } = makeService();
    const byZone = dto({ terminalExternalId: undefined, zone: 'OTRO', zoneCustom: ' reservado vip ' });
    await service.create(TENANT, 'idem-val-0003', byZone, owner);
    expect(db.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, zone: 'OTRO/RESERVADO VIP', active: true } }),
    );
    expect(created[0]).toMatchObject({ terminalId: ZONE_TERMINAL });
  });

  it('sin datáfono ni zona, o zona sin datáfonos activos → 400', async () => {
    const neither = makeService();
    await expect(
      neither.service.create(TENANT, 'idem-val-0004', dto({ terminalExternalId: undefined }), owner),
    ).rejects.toBeInstanceOf(BadRequestException);
    const empty = makeService({ zoneTerminal: null });
    await expect(
      empty.service.create(TENANT, 'idem-val-0005', dto({ terminalExternalId: undefined, zone: 'MESAS' }), owner),
    ).rejects.toThrow(/MESAS/);
    expect(neither.created).toHaveLength(0);
    expect(empty.created).toHaveLength(0);
  });
});

describe('create — cobro desde la carta (Fase 1A)', () => {
  const bottle = {
    id: SERVICE_ITEM,
    name: 'Botella Moët',
    priceCents: 18_000,
    durationMin: null,
    category: 'VENUE_BAR',
    active: true,
  };

  it('importe y categoría los fija la carta del local (el importe enviado no cuenta)', async () => {
    const { service, db, created } = makeService({ serviceItem: bottle });
    await service.create(TENANT, 'idem-val-0010', dto({ amountCents: 1, serviceItemId: SERVICE_ITEM }), waiter);
    expect(db.serviceItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [SERVICE_ITEM] }, tenantId: TENANT } }),
    );
    expect(created[0]).toMatchObject({
      amountCents: 18_000,
      availableAmountCents: 18_000,
      serviceItemId: SERVICE_ITEM,
      serviceName: 'Botella Moët',
      durationMin: null,
      revenueCategory: 'VENUE_BAR',
      ref: 3,
    });
    // Y su línea, en Copas.
    expect(db.paymentLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ paymentId: PAYMENT_ID, category: 'VENUE_BAR', serviceItemId: SERVICE_ITEM, amountCents: 18_000 }),
      ],
    });
  });

  it('servicio de otra carta → 404; desactivado → 400', async () => {
    const missing = makeService({ serviceItem: null });
    await expect(
      missing.service.create(TENANT, 'idem-val-0011', dto({ serviceItemId: SERVICE_ITEM }), waiter),
    ).rejects.toBeInstanceOf(NotFoundException);
    const off = makeService({ serviceItem: { ...bottle, active: false } });
    await expect(
      off.service.create(TENANT, 'idem-val-0012', dto({ serviceItemId: SERVICE_ITEM }), waiter),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect([...missing.created, ...off.created]).toHaveLength(0);
  });
});

describe('create — el puesto decide lo que se cobra', () => {
  const bottle = { id: SERVICE_ITEM, name: 'Botella', priceCents: 18_000, durationMin: null, category: 'VENUE_BAR', active: true };

  it('la chica solo cobra Servicios: la barra, ni de la carta ni tecleada (403 SECTION_NOT_ALLOWED) y no se guarda nada', async () => {
    const carta = makeService({ serviceItem: bottle });
    await expect(carta.service.create(TENANT, 'idem-val-0030', dto({ serviceItemId: SERVICE_ITEM }), operator)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'SECTION_NOT_ALLOWED', section: 'VENUE_BAR' }),
    });
    const typed = makeService();
    await expect(typed.service.create(TENANT, 'idem-val-0031', dto({ revenueCategory: 'VENUE_ROOM' }), operator)).rejects.toThrow(
      /Desde tu app solo puedes cobrar Servicios/,
    );
    expect([...carta.created, ...typed.created]).toHaveLength(0);
  });

  it('el camarero de barra: Copas, Comida y Entradas sí; Habitaciones no; el dueño, todo', async () => {
    const ok = makeService();
    await ok.service.create(TENANT, 'idem-val-0032', dto({ revenueCategory: 'VENUE_ENTRY' }), waiter);
    expect(ok.created[0]).toMatchObject({ revenueCategory: 'VENUE_ENTRY' });
    const room = makeService();
    await expect(room.service.create(TENANT, 'idem-val-0033', dto({ revenueCategory: 'VENUE_ROOM' }), waiter)).rejects.toThrow(
      /Desde tu puesto \(Barra\) no se cobra Habitaciones: solo Copas, Comida y Entradas/,
    );
    const boss = makeService();
    await boss.service.create(TENANT, 'idem-val-0034', dto({ revenueCategory: 'VENUE_ROOM' }), owner);
    expect(boss.created[0]).toMatchObject({ revenueCategory: 'VENUE_ROOM' });
  });

  it('recepción: todas las secciones, pero sin propinas', async () => {
    const recepcion = makeService();
    recepcion.db.user.findFirst.mockImplementation(async () => ({ id: BENEFICIARY, commissionBps: null, post: 'RECEPCION' }) as never);
    await recepcion.service.create(TENANT, 'idem-val-0035', dto({ revenueCategory: 'VENUE_ROOM' }), waiter);
    expect(recepcion.created[0]).toMatchObject({ revenueCategory: 'VENUE_ROOM' });
    await expect(recepcion.service.create(TENANT, 'idem-val-0036', dto({ tipCents: 200 }), waiter)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'TIPS_NOT_ALLOWED' }),
    });
  });

  it('las recargas, solo en recepción (o el encargado y el dueño): la chica y el camarero de barra → 403', async () => {
    for (const actor of [operator, waiter]) {
      const { service, created } = makeService();
      await expect(service.create(TENANT, 'idem-val-0037', dto({ wallet: { walletId: WALLET } }), actor)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'TOP_UP_RECEPTION_ONLY', message: 'Las recargas se hacen en recepción.' }),
      });
      expect(created).toHaveLength(0);
    }
    const recepcion = makeService();
    recepcion.db.user.findFirst.mockImplementation(async () => ({ id: BENEFICIARY, commissionBps: null, post: 'RECEPCION' }) as never);
    await recepcion.service.create(TENANT, 'idem-val-0038', dto({ wallet: { walletId: WALLET } }), waiter);
    expect(recepcion.created[0]).toMatchObject({ captureMethod: 'WALLET_TOPUP' });
  });
});

describe('create — recarga de saldo', () => {
  it('saldo activo de este local → el cobro queda ligado a él, como recarga (EXTRA)', async () => {
    const { service, db, created } = makeService();
    await service.create(TENANT, 'idem-val-0020', dto({ wallet: { walletId: WALLET } }), owner);
    expect(db.clientWallet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WALLET, tenantId: TENANT } }),
    );
    expect(created[0]).toMatchObject({ walletId: WALLET, captureMethod: 'WALLET_TOPUP', revenueCategory: 'EXTRA' });
  });

  it('saldo de otro local → 404; saldo cerrado → 400; sin crear nada', async () => {
    const other = makeService({ wallet: null });
    await expect(
      other.service.create(TENANT, 'idem-val-0021', dto({ wallet: { walletId: WALLET } }), owner),
    ).rejects.toThrow(new NotFoundException('Saldo no encontrado en este local'));
    const blocked = makeService({ wallet: { id: WALLET, status: 'REFUNDED' } });
    await expect(
      blocked.service.create(TENANT, 'idem-val-0022', dto({ wallet: { walletId: WALLET } }), owner),
    ).rejects.toThrow('Este saldo ya está cerrado: no se puede recargar. Haz un saldo nuevo.');
    // Bloqueado por el super-admin (aunque siga ACTIVE): 409 WALLET_BLOCKED, ni con tarjeta.
    const byAdmin = makeService({ wallet: { id: WALLET, status: 'ACTIVE', blockedAt: NOW } });
    await expect(
      byAdmin.service.create(TENANT, 'idem-val-0024', dto({ wallet: { walletId: WALLET } }), owner),
    ).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'WALLET_BLOCKED' }) });
    expect([...other.created, ...blocked.created, ...byAdmin.created]).toHaveLength(0);
  });

  it('saldo nuevo: 5 códigos cortos ocupados seguidos → 409 y no se guarda el cobro', async () => {
    const { service, db, created } = makeService({ walletInsert: [] });
    await expect(
      service.create(TENANT, 'idem-val-0023', dto({ wallet: { create: true } }), owner),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.$queryRaw).toHaveBeenCalledTimes(5);
    expect(created).toHaveLength(0);
  });
});

describe('create — propina para una persona del local', () => {
  const tipTo = (extra: Partial<CreatePaymentDto>) => dto({ tipCents: 500, tipGoesTo: 'beneficiary', ...extra });

  it('«para una persona» sin decir quién → 400', async () => {
    const { service, created } = makeService();
    await expect(service.create(TENANT, 'idem-val-0030', tipTo({}), owner)).rejects.toThrow(/tipBeneficiaryUserId/);
    expect(created).toHaveLength(0);
  });

  it('persona que no es de este local (o dada de baja) → 400', async () => {
    const { service, db, created } = makeService({ beneficiaryExists: false });
    await expect(
      service.create(TENANT, 'idem-val-0031', tipTo({ tipBeneficiaryUserId: BENEFICIARY }), owner),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: BENEFICIARY, tenantId: TENANT, deletedAt: null } }),
    );
    expect(created).toHaveLength(0);
  });
});

describe('create — caducidad y QR', () => {
  it('cobro con QR: caduca a los 5 min y el QR lleva a /pay/<token>', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'api.oxiopay.es/');
    vi.stubEnv('NEXT_PUBLIC_WEB_CLIENT_URL', '   ');
    const { service, created, qrQueue, metrics } = makeService();
    const out = await service.create(TENANT, 'idem-val-0040', dto(), owner);
    expect(created[0]!.qrExpiresAt).toEqual(new Date('2026-10-17T01:35:00+02:00'));
    expect(out.qrUrl).toBe(`https://api.oxiopay.es/pay/${created[0]!.qrToken as string}`);
    expect(out.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(out.qrExpiresAt).toBe('2026-10-16T23:35:00.000Z');
    expect(qrQueue.add).toHaveBeenCalledWith(
      'qr-expire',
      { paymentId: PAYMENT_ID, tenantId: TENANT },
      expect.objectContaining({ jobId: `qr-expire-${PAYMENT_ID}`, delay: 300_000 }),
    );
    expect(metrics.paymentsCreated.inc).toHaveBeenCalledWith({ venue: TENANT, provider: 'pending' });
  });

  it('cobro con datáfono externo: caduca a los 30 min y el QR abre la app del camarero', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.oxiopay.es');
    vi.stubEnv('NEXT_PUBLIC_OPERATOR_URL', '');
    const { service, created, qrQueue } = makeService();
    const out = await service.create(TENANT, 'idem-val-0041', dto({ captureMethod: 'POS_EXTERNAL' }), owner);
    expect(created[0]).toMatchObject({ captureMethod: 'POS_EXTERNAL', qrExpiresAt: new Date('2026-10-17T02:00:00+02:00') });
    expect(out.qrUrl).toBe(`https://operator.oxiopay.es/?pos=${PAYMENT_ID}`);
    expect(qrQueue.add).toHaveBeenCalledWith(
      'qr-expire',
      expect.anything(),
      expect.objectContaining({ delay: 1_800_000 }),
    );
  });
});

describe('create — choques únicos que no son la Idempotency-Key', () => {
  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test', meta: { target } });

  it('choque en otra columna → sale el error tal cual, sin buscar otro cobro', async () => {
    const clash = p2002(['qrToken']);
    const { service, db, qrQueue } = makeService({ createError: clash });
    await expect(service.create(TENANT, 'idem-val-0050', dto(), owner)).rejects.toBe(clash);
    expect(db.payment.findUnique).toHaveBeenCalledTimes(1);
    expect(qrQueue.add).not.toHaveBeenCalled();
  });

  it('choque en la clave pero el otro cobro no aparece → sale el error tal cual', async () => {
    const clash = p2002(['tenantId', 'idempotencyKey']);
    const { service, db } = makeService({ createError: clash });
    await expect(service.create(TENANT, 'idem-val-0051', dto(), owner)).rejects.toBe(clash);
    expect(db.payment.findUnique).toHaveBeenCalledTimes(2);
  });
});
