import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PublicPayController, walletClaimCookieName } from '../payments/public-pay.controller';
import { payerWalletFields } from '../payments/payments.service';
import type { PayRedirect, PayResultView } from '../payments/pay-redirect';
import { HomeTopUpService } from './home-topup.service';
import { HomeTopUpGiftService } from './home-topup-gift.service';
import {
  GIFT_TEXT_KEEP_DAYS,
  GIFT_UNCLAIMED_MAX_DAYS,
  eraseGiftTexts,
  giftExpiresAt,
  giftState,
  isGiftToken,
  newGiftToken,
  parseGiftTexts,
} from './home-topup-gift';
import { GIFT_KEY_PREFIX, giftShareHref, homeTopUpKey, isGiftPaymentKey, isHomeTopUpKey, isHomeTopUpPayment } from './home-topup-rules';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const CODE = 'AbCdEfGhIjKlMnOp';
const VENUE = '11111111-1111-4111-8111-111111111111';
const WALLET = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const KEY = 'k1234567890abcdef';
const NOW = new Date('2026-11-20T21:00:00.000Z');
const DAY = 86_400_000;

describe('«Regala una noche»: reglas del regalo', () => {
  it('el enlace del regalo: 192 bits al azar, 32 letras de base64url (como el QR de activación)', () => {
    const a = newGiftToken();
    expect(isGiftToken(a)).toBe(true);
    expect(a).not.toBe(newGiftToken());
    for (const bad of ['', 'corto', `${a}x`, `${a.slice(0, 31)}/`, 42, null]) expect(isGiftToken(bad)).toBe(false);
  });

  it('nombre (hasta 40) y mensaje (hasta 120): opcionales, en texto plano de una línea', () => {
    expect(parseGiftTexts(undefined, null)).toEqual({ toName: null, message: null });
    expect(parseGiftTexts('   ', '')).toEqual({ toName: null, message: null });
    expect(parseGiftTexts('  Ana \n María ', 'Feliz\u0007 cumple\r\n\u202epara ti')).toEqual({ toName: 'Ana María', message: 'Feliz cumple para ti' });
    expect(parseGiftTexts('a'.repeat(40), 'b'.repeat(120))).toEqual({ toName: 'a'.repeat(40), message: 'b'.repeat(120) });
    // Se cuentan caracteres de verdad (como char_length): 40 emojis valen.
    expect(parseGiftTexts('🎉'.repeat(40), null)?.toName).toBe('🎉'.repeat(40));
    expect(parseGiftTexts('a'.repeat(41), null)).toBeNull();
    expect(parseGiftTexts(null, 'b'.repeat(121))).toBeNull();
    expect(parseGiftTexts({ x: 1 }, null)).toBeNull();
    expect(parseGiftTexts(null, ['hola'])).toBeNull();
  });

  it('guardado (o el saldo ya activado por otra vía), caducado sin guardar a los 90 días, o abierto', () => {
    const expiresAt = giftExpiresAt(NOW);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(GIFT_UNCLAIMED_MAX_DAYS * DAY);
    expect(GIFT_UNCLAIMED_MAX_DAYS).toBe(90);
    const open = { claimedAt: null, expiresAt, walletActivated: false };
    expect(giftState(open, NOW)).toBe('open');
    expect(giftState({ ...open, claimedAt: NOW }, NOW)).toBe('claimed');
    expect(giftState({ ...open, walletActivated: true }, NOW)).toBe('claimed');
    expect(giftState(open, new Date(expiresAt.getTime() - 1))).toBe('open');
    expect(giftState(open, expiresAt)).toBe('expired');
    // Guardado gana a caducado: el regalo ya es de quien lo guardó.
    expect(giftState({ ...open, claimedAt: NOW }, new Date(expiresAt.getTime() + DAY))).toBe('claimed');
  });

  it('su cobro: `wcasa:regalo:`, «Desde casa» en el panel y en los topes, pero un regalo', () => {
    const key = homeTopUpKey(SECRET, VENUE, KEY, 'gift');
    expect(key.startsWith(GIFT_KEY_PREFIX)).toBe(true);
    expect(key.slice(GIFT_KEY_PREFIX.length)).toBe(homeTopUpKey(SECRET, VENUE, KEY).slice('wcasa:'.length));
    expect(isHomeTopUpKey(key)).toBe(true);
    expect(isHomeTopUpPayment({ idempotencyKey: key, createdByUserId: null })).toBe(true);
    expect(isGiftPaymentKey(key)).toBe(true);
    expect(isGiftPaymentKey(homeTopUpKey(SECRET, VENUE, KEY))).toBe(false);
    expect(isGiftPaymentKey(homeTopUpKey(SECRET, VENUE, KEY, 'queue'))).toBe(false);
    expect(isGiftPaymentKey('wcasa:regalo:nohex')).toBe(false);
    expect(isGiftPaymentKey(null)).toBe(false);
  });

  it('el nombre y el mensaje se borran a los 30 días de guardarlo o al caducar sin guardar', async () => {
    const updateMany = vi.fn(async () => ({ count: 3 }));
    const prisma = { asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ walletGift: { updateMany } })) };
    expect(await eraseGiftTexts(prisma as never, NOW)).toBe(3);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        OR: [{ toName: { not: null } }, { message: { not: null } }],
        AND: [{ OR: [{ claimedAt: { lt: new Date(NOW.getTime() - GIFT_TEXT_KEEP_DAYS * DAY) } }, { claimedAt: null, expiresAt: { lte: NOW } }] }],
      },
      data: { toName: null, message: null },
    });
  });
});

describe('quien regala nunca tiene el saldo', () => {
  const walletRow = { qrToken: 'walletTok', shortCode: 'K7Q4M2', pinHash: null, _count: { passkeys: 0 } };
  const GIFT_KEY = homeTopUpKey(SECRET, VENUE, KEY, 'gift');

  it('payerWalletFields: ni el enlace, ni el código, ni Face ID o PIN, ni la bienvenida (sí con una carga normal)', () => {
    const gift = payerWalletFields({ wallet: walletRow, firstTopUp: true, idempotencyKey: GIFT_KEY, approvedClaimHash: 'h' });
    expect(gift).toEqual({ walletToken: null, walletClaimHash: null, walletCode: null, walletHasFaceId: false, walletHasPin: false });
    const normal = payerWalletFields({ wallet: walletRow, firstTopUp: true, idempotencyKey: homeTopUpKey(SECRET, VENUE, KEY), approvedClaimHash: 'h' });
    expect(normal.walletToken).toBe('walletTok');
  });

  const CLAIM = 'a'.repeat(43);
  const CLAIM_HASH = createHash('sha256').update(CLAIM).digest('hex');
  function reply(cookie?: string) {
    const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
    const r = {
      request: { headers: cookie ? { cookie } : {} },
      status(code: number) {
        sent.status = code;
        return r;
      },
      header(k: string, v: string) {
        sent.headers[k] = v;
        return r;
      },
      send(body?: string) {
        sent.body = body;
        return r;
      },
    };
    return { res: r as unknown as FastifyReply, sent };
  }
  function pay(o: { view?: PayResultView; page?: PayRedirect }) {
    const payments = {
      getResultView: vi.fn().mockResolvedValue(o.view ?? null),
      getPayPage: vi.fn().mockResolvedValue(o.page),
      giftToken: vi.fn().mockResolvedValue('G'.repeat(32)),
    };
    const ctrl = new PublicPayController(
      payments as never,
      { get: vi.fn(() => undefined) } as never,
      {} as never,
      {} as never,
      { process: vi.fn().mockResolvedValue('enviado') } as never,
      { byToken: vi.fn().mockResolvedValue(null), byOrder: vi.fn().mockResolvedValue(null) } as never,
    );
    return { ctrl, payments };
  }
  const cookie = `${walletClaimCookieName('', 'payTok')}=${CLAIM}`;
  const page: PayRedirect = {
    kind: 'paid',
    paymentId: 'p1',
    amountCents: 5000,
    tipCents: 0,
    currency: 'EUR',
    authorizedAt: new Date(),
    walletToken: null,
    walletClaimHash: null,
    walletCode: null,
    walletHasFaceId: false,
    walletHasPin: false,
    approvedClaimHash: CLAIM_HASH,
    gift: true,
  };

  it('pagado, en el navegador que pagó: 303 a «Comparte tu regalo» (el enlace del regalo, nunca /w)', async () => {
    const mine = reply(cookie);
    await pay({ page }).ctrl.payPage('payTok', 'fr', undefined, undefined, mine.res);
    expect(mine.sent.status).toBe(303);
    expect(mine.sent.headers.Location).toBe(giftShareHref('G'.repeat(32), 'fr'));
    expect(mine.sent.headers.Location).toBe(`/r/regalo/${'G'.repeat(32)}?lang=fr&comprado=1`);
    // Desde otro navegador (el enlace del pago reenviado): el «Pagado» de siempre, sin el regalo.
    const other = reply();
    const p = pay({ page });
    await p.ctrl.payPage('payTok', 'es', undefined, undefined, other.res);
    expect(other.sent.status).toBe(200);
    expect(p.payments.giftToken).not.toHaveBeenCalled();
  });

  it('vuelta del banco: lo mismo', async () => {
    const view: PayResultView = {
      paymentId: 'p1',
      status: 'AUTHORIZED',
      amountCents: 5000,
      tipCents: 0,
      currency: 'EUR',
      authorizedAt: new Date(),
      qrToken: 'payTok',
      walletToken: null,
      walletClaimHash: null,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
      attemptStatus: 'APPROVED',
      approvedClaimHash: CLAIM_HASH,
      gift: true,
    };
    const { res, sent } = reply(cookie);
    await pay({ view }).ctrl.paymentResult('ORDER1', 'es', undefined, res, {});
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe(`/r/regalo/${'G'.repeat(32)}?lang=es&comprado=1`);
  });

  it('las vías del móvil que pagó (Face ID, PIN, sumar a su saldo) no le valen: 403', async () => {
    const { ctrl } = pay({ page });
    const { res } = reply(cookie);
    await expect(ctrl.walletPin('payTok', { pin: '4827', pin2: '4827' }, 'api.test', 'https://api.test', undefined, res)).rejects.toMatchObject({
      response: { code: 'PAYER_ONLY' },
    });
  });
});

describe('HomeTopUpService.start con «Para regalar»', () => {
  function make(o: { gifts?: boolean } = {}) {
    const venue = {
      id: VENUE,
      name: 'Sala Aurora',
      homeTopUpEnabled: true,
      homeTopUpGiftsEnabled: o.gifts ?? true,
      deletedAt: null,
      pausedAt: null,
      business: null,
      paymentMethods: null,
      serviceFeeEnabled: false,
      serviceFeeBps: 1000,
      topUpServiceFeeBps: 1000,
    };
    const tx = {
      venue: { findUnique: vi.fn(async () => venue) },
      gatewayCredential: { count: vi.fn(async () => 1) },
      terminal: { findFirst: vi.fn(async () => ({ externalId: 'T1' })) },
      payment: { findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) },
      walletGift: { createMany: vi.fn(async () => ({ count: 1 })) },
      clientWallet: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const created = { id: 'p1', qrToken: 'payTok', status: 'CREATED', qrExpiresAt: new Date(Date.now() + 300_000).toISOString(), walletId: WALLET };
    const payments = { create: vi.fn(async () => created) };
    let n = 0;
    const redis = { incr: vi.fn(async () => ++n), decr: vi.fn(async () => --n), expire: vi.fn(async () => 1) };
    const service = new HomeTopUpService(prisma as never, payments as never, redis as never, { get: vi.fn(() => SECRET) } as never);
    return { service, tx, payments };
  }
  const gift = (s: HomeTopUpService, amountCents: unknown = 5000, g: { name?: unknown; message?: unknown } = { name: 'Ana', message: 'Feliz cumple' }) =>
    s.start(CODE, { amountCents, key: KEY, lang: 'es', ip: null, gift: { name: g.name, message: g.message } });

  it('con «Regalos» apagado: 404 sin pistas, como un enlace apagado (y no se crea nada)', async () => {
    const m = make({ gifts: false });
    await expect(gift(m.service)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.payments.create).not.toHaveBeenCalled();
    // La carga normal sí.
    await expect(m.service.start(CODE, { amountCents: 5000, key: KEY, lang: 'es', ip: null })).resolves.toMatchObject({ payToken: 'payTok' });
  });

  it('en OxioParty no hay regalos aunque el interruptor esté encendido: 404, y la carga normal sí', async () => {
    vi.stubEnv('EDITION', 'party');
    try {
      const m = make();
      await expect(gift(m.service)).rejects.toBeInstanceOf(NotFoundException);
      expect(m.payments.create).not.toHaveBeenCalled();
      expect((await m.service.venueByCode(CODE))?.gifts).toBe(false);
      await expect(m.service.start(CODE, { amountCents: 5000, key: KEY, lang: 'es', ip: null })).resolves.toMatchObject({ payToken: 'payTok' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('los mismos importes que una carga (euros enteros de 10 a 300 €)', async () => {
    const m = make();
    for (const bad of [999, 30100, 5050, '50', null]) {
      await expect(gift(m.service, bad)).rejects.toMatchObject({ response: { code: 'WALLET_TOPUP_AMOUNT' } });
    }
    await expect(gift(m.service, 1000)).resolves.toBeTruthy();
    await expect(gift(m.service, 30000)).resolves.toBeTruthy();
  });

  it('un nombre o un mensaje demasiado largos: 400 GIFT_TEXT, sin crear el cobro', async () => {
    const m = make();
    const err = await gift(m.service, 5000, { name: 'a'.repeat(41) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err).toMatchObject({ response: { code: 'GIFT_TEXT' } });
    expect(m.payments.create).not.toHaveBeenCalled();
  });

  it('crea el cobro de siempre (saldo nuevo, clave de regalo) y el regalo con su enlace al azar; el doble toque no crea otro', async () => {
    const m = make();
    const out = await gift(m.service);
    expect(out.payUrl).toBe('/pay/payTok?lang=es');
    expect(m.payments.create).toHaveBeenCalledWith(VENUE, homeTopUpKey(SECRET, VENUE, KEY, 'gift'), expect.objectContaining({ amountCents: 5000, wallet: { create: true } }));
    const call = m.tx.walletGift.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>>; skipDuplicates: boolean }];
    const row = call[0].data[0]!;
    expect(call[0].skipDuplicates).toBe(true);
    expect(row).toMatchObject({ tenantId: VENUE, walletId: WALLET, paymentId: 'p1', toName: 'Ana', message: 'Feliz cumple' });
    expect(isGiftToken(row.token)).toBe(true);
    // Solo en este local: el saldo nuevo, sin el grupo de locales.
    expect(m.tx.clientWallet.updateMany).toHaveBeenCalledWith({ where: { id: WALLET, tenantId: VENUE }, data: { walletGroup: null } });
    expect((row.expiresAt as Date).getTime() - (row.createdAt as Date).getTime()).toBe(GIFT_UNCLAIMED_MAX_DAYS * DAY);
  });
});

describe('HomeTopUpGiftService: la página del regalo y «Guardar en mi móvil»', () => {
  const TOKEN = 'T'.repeat(32);
  function make(o: { claimedAt?: Date | null; expiresAt?: Date; status?: string; pinHash?: string | null; passkeys?: number; deleted?: boolean } = {}) {
    const gift = {
      tenantId: VENUE,
      walletId: WALLET,
      toName: 'Ana',
      message: 'Feliz cumple',
      expiresAt: o.expiresAt ?? new Date(NOW.getTime() + 10 * DAY),
      claimedAt: o.claimedAt ?? null,
      venue: { name: 'Sala Aurora', deletedAt: o.deleted ? NOW : null },
      payment: { amountCents: 5000, status: o.status ?? 'AUTHORIZED' },
      wallet: { pinHash: o.pinHash ?? null, _count: { passkeys: o.passkeys ?? 0 } },
    };
    const tx = {
      walletGift: { findUnique: vi.fn(async () => gift) },
      walletActivationToken: { updateMany: vi.fn(async () => ({ count: 0 })), create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async () => []),
    };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const config = { get: vi.fn((k: string) => (k === 'NEXT_PUBLIC_API_URL' ? 'https://api.sala.test/v1' : undefined)) };
    return { service: new HomeTopUpGiftService(prisma as never, config as never), tx, gift };
  }

  it('lo que pinta: cuánto, el local, el nombre y el mensaje; el enlace entero es el del API', async () => {
    const m = make();
    expect(await m.service.view(TOKEN, NOW)).toEqual({
      state: 'open',
      venueName: 'Sala Aurora',
      amountCents: 5000,
      toName: 'Ana',
      message: 'Feliz cumple',
      expiresAt: m.gift.expiresAt,
    });
    expect(m.service.origin).toBe('https://api.sala.test');
  });

  it('sin forma, sin pagar o de un local borrado: 404 (null), sin mirar más', async () => {
    const bad = make();
    expect(await bad.service.view('corto', NOW)).toBeNull();
    expect(await bad.service.claim('corto', NOW)).toBeNull();
    expect(bad.tx.walletGift.findUnique).not.toHaveBeenCalled();
    // REFUNDED: devuelto entero a quien lo pagó, el enlace ya no da nada (el panel sí lo lista).
    for (const status of ['CREATED', 'AUTHORIZING', 'FAILED', 'EXPIRED', 'CANCELED', 'REFUNDED']) {
      expect(await make({ status }).service.view(TOKEN, NOW)).toBeNull();
      expect(await make({ status }).service.claim(TOKEN, NOW)).toBeNull();
    }
    expect(await make({ deleted: true }).service.view(TOKEN, NOW)).toBeNull();
  });

  it('«Guardar en mi móvil»: el QR de activación de siempre (via gift, 10 min), con el saldo bloqueado', async () => {
    const m = make();
    const out = await m.service.claim(TOKEN, NOW);
    expect(out).toMatchObject({ activationPath: expect.stringMatching(/^\/w\/a\/[A-Za-z0-9_-]{32}$/) });
    expect(m.tx.$queryRaw).toHaveBeenCalledTimes(1);
    // Anula los QR anteriores sin usar del saldo y guarda solo el hash del nuevo.
    expect(m.tx.walletActivationToken.updateMany).toHaveBeenCalledWith({ where: { walletId: WALLET, usedAt: null, revokedAt: null }, data: { revokedAt: NOW } });
    const created = m.tx.walletActivationToken.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(created[0].data).toMatchObject({ walletId: WALLET, venueId: VENUE, issuedById: null, via: 'gift' });
    expect(String(created[0].data.tokenHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ya guardado: el enlace de quien regaló (o de cualquiera) ya no da nada, ni la segunda vez', async () => {
    for (const m of [make({ claimedAt: NOW }), make({ pinHash: 'h' }), make({ passkeys: 1 })]) {
      expect((await m.service.view(TOKEN, NOW))?.state).toBe('claimed');
      expect(await m.service.claim(TOKEN, NOW)).toEqual({ state: 'claimed' });
      expect(await m.service.claim(TOKEN, NOW)).toEqual({ state: 'claimed' });
      expect(m.tx.walletActivationToken.create).not.toHaveBeenCalled();
    }
  });

  it('caducado sin guardar (pasados los 90 días): no se guarda; la página lo dice', async () => {
    const m = make({ expiresAt: new Date(NOW.getTime() - 1) });
    expect((await m.service.view(TOKEN, NOW))?.state).toBe('expired');
    expect(await m.service.claim(TOKEN, NOW)).toEqual({ state: 'expired' });
    expect(m.tx.walletActivationToken.create).not.toHaveBeenCalled();
  });
});
