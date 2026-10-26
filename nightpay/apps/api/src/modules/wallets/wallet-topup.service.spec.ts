import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { PAYMENT_METHOD_DISABLED_CODE } from '@nightpay/contracts';
import { WalletTopUpService } from './wallet-topup.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { VENUE_PAUSED_STATUS } from '../venues/venue-pause';
import { selfTopUpClaim, selfTopUpClaimHash, selfTopUpKey } from './wallet-topup-rules';

const SECRET = 'secreto-de-cookies-de-las-pruebas-0123456789';
const WALLET = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const VENUE = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const KEY = 'clave-del-navegador-01';

interface Setup {
  wallet?: Record<string, unknown> | null;
  venue?: Record<string, unknown>;
  gateways?: number;
  lastTerminal?: { externalId: string; active: boolean } | null;
  anyTerminal?: { externalId: string } | null;
  hasPasskey?: boolean;
  verifiedWallet?: string;
  incr?: number | Error;
  created?: Record<string, unknown>;
  paidPayment?: Record<string, unknown> | null;
  /** Recargas desde /w del saldo en las últimas 24 h: la 1ª consulta (antes de crear) y la 2ª (después). */
  recent?: Array<Record<string, unknown>>;
  recentAfter?: Array<Record<string, unknown>>;
}

function make(s: Setup = {}) {
  const wallet =
    s.wallet === null
      ? null
      : { id: WALLET, tenantId: VENUE, status: 'ACTIVE', blockedAt: null, mergedIntoId: null, closeRequestedAt: null, ...s.wallet };
  const db = {
    clientWallet: { findUnique: vi.fn(async () => wallet) },
    venue: {
      findUnique: vi.fn(async () => ({ pausedAt: null, business: null, paymentMethods: null, ...s.venue })),
    },
    gatewayCredential: { count: vi.fn(async () => s.gateways ?? 1) },
    payment: {
      findFirst: vi.fn(async () =>
        s.lastTerminal === null ? null : { terminal: s.lastTerminal ?? { externalId: 'BARRA-1', active: true } },
      ),
      findUnique: vi.fn(async () => (s.paidPayment === undefined ? null : s.paidPayment)),
      findMany: vi
        .fn()
        .mockResolvedValueOnce(s.recent ?? [])
        .mockImplementation(async () => s.recentAfter ?? [...(s.recent ?? []), { id: PAYMENT, ...row(5000, 'CREATED') }]),
    },
    terminal: { findFirst: vi.fn(async () => (s.anyTerminal === undefined ? { externalId: 'AAA-0' } : s.anyTerminal)) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) };
  const passkeys = {
    hasPasskey: vi.fn(async () => s.hasPasskey ?? false),
    verify: vi.fn(async () => s.verifiedWallet ?? WALLET),
    challenge: vi.fn(async () => ({ challenge: 'reto' })),
    // La de verdad (hasPasskey + verify de arriba).
    assertOwner: WalletPasskeysService.prototype.assertOwner,
  };
  const redis = {
    incr: vi.fn(async () => {
      if (s.incr instanceof Error) throw s.incr;
      return s.incr ?? 1;
    }),
    expire: vi.fn(async () => 1),
  };
  const payments = {
    transition: vi.fn(async () => undefined),
    create: vi.fn(async () => ({
      id: PAYMENT,
      status: 'CREATED',
      qrToken: 'pay-tok-1',
      qrExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      ...s.created,
    })),
  };
  const config = { get: vi.fn(() => SECRET) };
  const moduleRef = { get: vi.fn(() => payments) };
  const service = new WalletTopUpService(
    prisma as never,
    passkeys as never,
    redis as never,
    config as never,
    moduleRef as never,
  );
  return { service, db, passkeys, redis, payments };
}

const PAYMENT = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
/** Una recarga desde /w de las últimas 24 h (qrExpiresAt en el futuro: aún se puede pagar). */
function row(amountCents: number, status: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `p-${Math.random()}`, idempotencyKey: 'wtopup:otra', amountCents, status, qrExpiresAt: new Date(Date.now() + 60_000), ...o };
}

const start = (service: WalletTopUpService, o: Record<string, unknown> = {}) =>
  service.start('w-tok', { amountCents: 5000, key: KEY, lang: 'es', ...o }, 'api.oxiopay.test');

describe('WalletTopUpService.start — crea la recarga de ESTE saldo con la maquinaria de siempre', () => {
  it('cobro de recarga del saldo en su local, sin propina, con el datáfono de su última recarga', async () => {
    const { service, payments } = make();
    const out = await start(service);
    expect(payments.create).toHaveBeenCalledTimes(1);
    const [tenant, idemKey, dto, actor] = payments.create.mock.calls[0] as unknown as [string, string, Record<string, unknown>, unknown];
    expect(tenant).toBe(VENUE);
    expect(dto).toEqual({ amountCents: 5000, currency: 'EUR', terminalExternalId: 'BARRA-1', wallet: { walletId: WALLET } });
    expect(dto).not.toHaveProperty('tipCents');
    // Sin persona del personal: el cobro no es de nadie (sin comisión ni propina de chica).
    expect(actor).toBeUndefined();
    // La clave lleva la huella de la cookie de vuelta (la del navegador que la empieza).
    expect(selfTopUpClaimHash(idemKey)).not.toBeNull();
    expect(idemKey).toBe(selfTopUpKey(selfTopUpClaim(SECRET, WALLET, KEY)));
    expect(out).toEqual({ payToken: 'pay-tok-1', payUrl: '/pay/pay-tok-1?lang=es', claim: selfTopUpClaim(SECRET, WALLET, KEY) });
  });

  it('doble toque (la misma clave del navegador) → la misma Idempotency-Key → el mismo cobro', async () => {
    const { service, payments } = make();
    await start(service);
    await start(service);
    expect(payments.create.mock.calls[0]![1]).toBe(payments.create.mock.calls[1]![1]);
  });

  it('a cero (DEPLETED) también se puede recargar', async () => {
    const { service, payments } = make({ wallet: { status: 'DEPLETED' } });
    await start(service);
    expect(payments.create).toHaveBeenCalled();
  });

  it('el datáfono de su última recarga ya no está activo → el primero activo del local; ninguno → 409', async () => {
    const a = make({ lastTerminal: { externalId: 'VIEJO', active: false }, anyTerminal: { externalId: 'MESAS-2' } });
    await start(a.service);
    expect((a.payments.create.mock.calls[0]![2] as { terminalExternalId: string }).terminalExternalId).toBe('MESAS-2');
    const b = make({ lastTerminal: null, anyTerminal: null });
    await expect(start(b.service)).rejects.toThrow(ConflictException);
    expect(b.payments.create).not.toHaveBeenCalled();
  });

  it('importe fuera de límites o con céntimos → 400 sin crear nada', async () => {
    for (const amountCents of [900, 30_100, 1050, '5000', undefined]) {
      const { service, payments } = make();
      await expect(start(service, { amountCents })).rejects.toThrow(BadRequestException);
      expect(payments.create).not.toHaveBeenCalled();
    }
  });

  it('sin clave del navegador válida → 400', async () => {
    const { service, payments } = make();
    await expect(start(service, { key: 'corta' })).rejects.toThrow(BadRequestException);
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('enlace que no existe → 404', async () => {
    const { service } = make({ wallet: null });
    await expect(start(service)).rejects.toThrow(NotFoundException);
  });
});

describe('WalletTopUpService.start — seguridad', () => {
  it('saldo con Face ID: sin desbloquear el móvil no se crea nada; el reto va atado a recargar este saldo', async () => {
    const { service, passkeys, payments } = make({ hasPasskey: true });
    passkeys.verify.mockRejectedValueOnce(new ForbiddenException('Confirma con Face ID'));
    await expect(start(service)).rejects.toThrow(ForbiddenException);
    expect(passkeys.verify).toHaveBeenCalledWith(`topup:${WALLET}`, 'api.oxiopay.test', undefined);
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('saldo con Face ID: la llave de OTRO saldo no vale', async () => {
    const { service, payments } = make({ hasPasskey: true, verifiedWallet: 'otro-saldo' });
    await expect(start(service, { response: { id: 'k' } })).rejects.toThrow(ForbiddenException);
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('saldo con Face ID y su llave → se crea', async () => {
    const { service, payments, passkeys } = make({ hasPasskey: true });
    await start(service, { response: { id: 'k' } });
    expect(passkeys.verify).toHaveBeenCalledWith(`topup:${WALLET}`, 'api.oxiopay.test', { id: 'k' });
    expect(payments.create).toHaveBeenCalled();
  });

  it('saldo sin Face ID: basta el enlace (no se pide llave)', async () => {
    const { service, passkeys } = make();
    await start(service);
    expect(passkeys.verify).not.toHaveBeenCalled();
  });

  it('límite por saldo: a partir de la 7ª en 15 min → 429; la ventana se pone con la primera', async () => {
    const first = make({ incr: 1 });
    await start(first.service);
    expect(first.redis.expire).toHaveBeenCalledWith(`np:wallet-topup:${WALLET}`, 900);
    const ok = make({ incr: 6 });
    await expect(start(ok.service)).resolves.toBeDefined();
    const over = make({ incr: 7 });
    const err = await start(over.service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(over.payments.create).not.toHaveBeenCalled();
  });

  it('sin Redis no se recarga desde el móvil (503 TRY_LATER): sin el límite por saldo quedaría solo el de la IP', async () => {
    const { service, payments } = make({ incr: new Error('ECONNREFUSED') });
    const err = await start(service).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(503);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'TRY_LATER' });
    expect(payments.create).not.toHaveBeenCalled();
  });
});

describe('WalletTopUpService.start — tope de 24 h por saldo (en la base)', () => {
  it('cabe: 500 € pagados hoy + 50 € → se crea; + 150 € → 409 WALLET_TOPUP_DAILY_LIMIT', async () => {
    const paid = [row(30_000, 'AUTHORIZED'), row(20_000, 'AUTHORIZED')];
    const ok = make({ recent: paid });
    await start(ok.service, { amountCents: 5000 });
    expect(ok.payments.create).toHaveBeenCalled();
    expect(ok.db.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ walletId: WALLET, idempotencyKey: { startsWith: 'wtopup:' } }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    const over = make({ recent: paid, hasPasskey: true });
    const err = await start(over.service, { amountCents: 15_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_DAILY_LIMIT' });
    expect(over.payments.create).not.toHaveBeenCalled();
    // Antes de pedir el Face ID: no se gasta un desbloqueo en algo que no cabe.
    expect(over.passkeys.verify).not.toHaveBeenCalled();
  });

  it('4 pagadas en 24 h → 409 aunque el importe quepa; lo caducado, fallido o cancelado no cuenta', async () => {
    const four = make({ recent: Array.from({ length: 4 }, () => row(2000, 'AUTHORIZED')) });
    await expect(start(four.service, { amountCents: 2000 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WALLET_TOPUP_DAILY_LIMIT' }),
    });
    const dead = [
      row(30_000, 'EXPIRED'),
      row(30_000, 'FAILED'),
      row(30_000, 'CANCELED'),
      row(30_000, 'CREATED', { qrExpiresAt: new Date(Date.now() - 1000) }),
    ];
    const fine = make({ recent: dead });
    await expect(start(fine.service, { amountCents: 30_000 })).resolves.toBeDefined();
  });

  it('3 a medias o sin confirmar (en el banco, ORPHAN o QR vigente) → 409 WALLET_TOPUP_PENDING_LIMIT', async () => {
    const pending = make({ recent: [row(1000, 'AUTHORIZING'), row(1000, 'ORPHAN'), row(1000, 'CREATED')] });
    await expect(start(pending.service)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WALLET_TOPUP_PENDING_LIMIT' }),
    });
    expect(pending.payments.create).not.toHaveBeenCalled();
  });

  it('doble toque: la misma clave ya tiene su cobro → no se vuelve a mirar el tope (ni se cancela)', async () => {
    const mine = { ...row(30_000, 'CREATED'), id: PAYMENT, idempotencyKey: selfTopUpKey(selfTopUpClaim(SECRET, WALLET, KEY)) };
    const full = [row(30_000, 'AUTHORIZED'), mine];
    const { service, payments } = make({ recent: full, recentAfter: full });
    await expect(start(service, { amountCents: 30_000 })).resolves.toMatchObject({ payToken: 'pay-tok-1' });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('dos «Recargar» a la vez que no caben: la que se creó después se cancela y da 409', async () => {
    // Antes de crear no había nada; al mirar otra vez, otra recarga de 400 € se creó justo antes que esta.
    const earlier = row(40_000, 'CREATED');
    const { service, payments } = make({
      recent: [],
      recentAfter: [earlier, { ...row(30_000, 'CREATED'), id: PAYMENT }],
    });
    const err = await start(service, { amountCents: 30_000 }).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_DAILY_LIMIT' });
    expect(payments.transition).toHaveBeenCalledWith(PAYMENT, { type: 'CANCELED', reason: 'wallet-topup-cap' });
    // La que se creó antes no mira las de después: sigue.
    const first = make({ recent: [], recentAfter: [{ ...row(30_000, 'CREATED'), id: PAYMENT }, row(40_000, 'CREATED')] });
    await expect(start(first.service, { amountCents: 30_000 })).resolves.toBeDefined();
    expect(first.payments.transition).not.toHaveBeenCalled();
  });
});

describe('WalletTopUpService.start — saldo bloqueado, pausa y «Formas de cobro»', () => {
  it('saldo bloqueado, sumado a otro, cerrado o con «Me voy» → 409 sin crear nada', async () => {
    for (const wallet of [
      { blockedAt: new Date() },
      { status: 'DEPLETED', mergedIntoId: 'w-2' },
      { status: 'REFUNDED' },
      { closeRequestedAt: new Date() },
    ]) {
      const { service, payments, passkeys } = make({ wallet, hasPasskey: true });
      const err = await start(service).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_UNAVAILABLE' });
      expect(payments.create).not.toHaveBeenCalled();
      // Ni se pide el Face ID para algo que no se puede hacer.
      expect(passkeys.verify).not.toHaveBeenCalled();
    }
  });

  it('local en pausa (o su negocio) → 423 VENUE_PAUSED', async () => {
    for (const venue of [{ pausedAt: new Date() }, { business: { status: 'PAUSED' } }]) {
      const { service, payments } = make({ venue });
      const err = await start(service).catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(VENUE_PAUSED_STATUS);
      expect(payments.create).not.toHaveBeenCalled();
    }
  });

  it('«Formas de cobro»: tarjeta por QR o saldo apagados → 409 PAYMENT_METHOD_DISABLED', async () => {
    for (const paymentMethods of [{ card: false }, { wallet: false }]) {
      const { service, payments } = make({ venue: { paymentMethods } });
      const err = await start(service).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: PAYMENT_METHOD_DISABLED_CODE });
      expect(payments.create).not.toHaveBeenCalled();
    }
  });

  it('las propinas apagadas no impiden recargar (la recarga no lleva propina)', async () => {
    const { service, payments } = make({ venue: { paymentMethods: { tips: false } } });
    await start(service);
    expect(payments.create).toHaveBeenCalled();
  });

  it('sin pasarela activa en el local → 409', async () => {
    const { service } = make({ gateways: 0 });
    await expect(start(service)).rejects.toThrow(ConflictException);
  });

  it('la misma clave repetida tarde (cobro ya caducado o cerrado) → 409 para empezar otra', async () => {
    for (const created of [
      { status: 'EXPIRED' },
      { status: 'FAILED' },
      { status: 'CANCELED' },
      { status: 'CREATED', qrExpiresAt: new Date(Date.now() - 1000).toISOString() },
    ]) {
      const { service } = make({ created });
      await expect(start(service)).rejects.toThrow(ConflictException);
    }
    // En curso en el banco o ya pagada: se va a /pay (que espera o enseña «Pagado»).
    for (const created of [{ status: 'AUTHORIZING' }, { status: 'AUTHORIZED' }]) {
      const { service } = make({ created });
      await expect(start(service)).resolves.toMatchObject({ payToken: 'pay-tok-1' });
    }
  });
});

describe('WalletTopUpService.options / challenge / paidProof', () => {
  it('options: si se puede y con qué importes', async () => {
    await expect(make().service.options('w-tok')).resolves.toEqual({
      allowed: true,
      block: null,
      presetsCents: [2000, 5000, 10000],
      minCents: 1000,
      maxCents: 30000,
      // Sin la «Comisión del servicio» encendida: nada encima.
      serviceFeeBps: null,
    });
    await expect(make({ venue: { pausedAt: new Date() } }).service.options('w-tok')).resolves.toMatchObject({
      allowed: false,
      block: 'paused',
    });
    // Encendida: el % de las recargas (la página enseña «Recargas · Comisión · Pagas»).
    const on = make({ venue: { serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1200 } });
    await expect(on.service.options('w-tok')).resolves.toMatchObject({ serviceFeeBps: 1200 });
  });

  it('challenge: solo con Face ID y si se puede recargar; atado a este saldo', async () => {
    const { service, passkeys } = make({ hasPasskey: true });
    await expect(service.challenge('w-tok', 'h')).resolves.toEqual({ challenge: 'reto' });
    expect(passkeys.challenge).toHaveBeenCalledWith(`topup:${WALLET}`, 'h');
    await expect(make().service.challenge('w-tok', 'h')).rejects.toThrow(ConflictException);
    await expect(make({ hasPasskey: true, wallet: { blockedAt: new Date() } }).service.challenge('w-tok', 'h')).rejects.toThrow(
      ConflictException,
    );
  });

  it('paidProof: solo una recarga PAGADA de este mismo saldo', async () => {
    const paid = { id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5abc', walletId: WALLET, status: 'AUTHORIZED', amountCents: 5000, authorizedAt: new Date('2026-10-19T22:00:00Z') };
    await expect(make({ paidPayment: paid }).service.paidProof('w-tok', 'pay-tok-1')).resolves.toEqual({
      payToken: 'pay-tok-1',
      amountCents: 5000,
      authorizedAt: '2026-10-19T22:00:00.000Z',
      code: 'ABC',
    });
    // De otro saldo, sin pagar, devuelta, inexistente o sin token → nada.
    for (const p of [{ ...paid, walletId: 'otro' }, { ...paid, status: 'AUTHORIZING' }, { ...paid, status: 'REFUNDED' }, null]) {
      await expect(make({ paidPayment: p }).service.paidProof('w-tok', 'pay-tok-1')).resolves.toBeNull();
    }
    await expect(make({ paidPayment: paid }).service.paidProof('w-tok', undefined)).resolves.toBeNull();
    await expect(make({ paidPayment: paid }).service.paidProof('w-tok', 'x'.repeat(65))).resolves.toBeNull();
    await expect(make({ paidPayment: paid, wallet: null }).service.paidProof('w-tok', 'pay-tok-1')).resolves.toBeNull();
  });
});
