import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HomeTopUpService } from './home-topup.service';
import { homeTopUpDay, homeTopUpKey, rememberSetCookie } from './home-topup-rules';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const CODE = 'AbCdEfGhIjKlMnOp';
const VENUE = '11111111-1111-4111-8111-111111111111';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const W2 = '3b4c5d6e-7f8a-4b9c-8d1e-2f3a4b5c6d7e';
const KEY = 'k1234567890abcdef';

interface Opts {
  venue?: Record<string, unknown> | null;
  gateways?: number;
  terminal?: { externalId: string } | null;
  replay?: boolean;
  unresolved?: number;
  wallets?: Array<Record<string, unknown>>;
  redisFails?: boolean;
  redisCount?: number;
  /** Cuenta de partida de una clave concreta (si no, redisCount). */
  redisStart?: (key: string) => number | undefined;
  created?: Record<string, unknown>;
}

function make(o: Opts = {}) {
  const venue =
    o.venue === undefined
      ? { id: VENUE, name: 'Sala Aurora', homeTopUpEnabled: true, deletedAt: null, pausedAt: null, business: null, paymentMethods: null, serviceFeeEnabled: false, serviceFeeBps: 1000, topUpServiceFeeBps: 1000 }
      : o.venue;
  const tx = {
    venue: { findUnique: vi.fn(async () => venue) },
    gatewayCredential: { count: vi.fn(async () => o.gateways ?? 1) },
    terminal: { findFirst: vi.fn(async () => (o.terminal === undefined ? { externalId: 'T1' } : o.terminal)) },
    payment: {
      findUnique: vi.fn(async () => (o.replay ? { id: 'p0' } : null)),
      count: vi.fn(async () => o.unresolved ?? 0),
    },
    clientWallet: { findMany: vi.fn(async () => o.wallets ?? []) },
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const created = {
    id: 'p1',
    qrToken: 'payTok',
    status: 'CREATED',
    qrExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    walletId: W1,
    ...o.created,
  };
  const payments = { create: vi.fn(async () => created) };
  const counts = new Map<string, number>();
  const redis = {
    incr: vi.fn(async (key: string) => {
      if (o.redisFails) throw new Error('redis caído');
      const n = (counts.get(key) ?? o.redisStart?.(key) ?? o.redisCount ?? 0) + 1;
      counts.set(key, n);
      return n;
    }),
    decr: vi.fn(async (key: string) => {
      const n = (counts.get(key) ?? o.redisStart?.(key) ?? o.redisCount ?? 0) - 1;
      counts.set(key, n);
      return n;
    }),
    expire: vi.fn(async () => 1),
  };
  const config = { get: vi.fn(() => SECRET) };
  const service = new HomeTopUpService(prisma as never, payments as never, redis as never, config as never);
  return { service, tx, prisma, payments, redis };
}

const start = (s: HomeTopUpService, input: Partial<{ amountCents: unknown; key: unknown; ip: string | null }> = {}) =>
  s.start(CODE, { amountCents: 5000, key: KEY, lang: 'es', ip: null, ...input });
const IP = '203.0.113.7';
const dayStart = (venue: number, all: number) => (k: string) =>
  k.startsWith('np:home-topup:ip-venue:') ? venue : k.startsWith('np:home-topup:ip:') ? all : undefined;

describe('HomeTopUpService.venueByCode / page', () => {
  it('apagado, borrado, sin local o con un código sin forma: null (404 sin pistas)', async () => {
    expect(await make({ venue: { id: VENUE, name: 'x', homeTopUpEnabled: false, deletedAt: null } }).service.page(CODE, undefined)).toBeNull();
    expect(await make({ venue: { id: VENUE, name: 'x', homeTopUpEnabled: true, deletedAt: new Date() } }).service.page(CODE, undefined)).toBeNull();
    expect(await make({ venue: null }).service.page(CODE, undefined)).toBeNull();
    const bad = make();
    expect(await bad.service.page('corto', undefined)).toBeNull();
    expect(bad.tx.venue.findUnique).not.toHaveBeenCalled();
  });

  it('la página: el local, los importes de «Recargar» y la comisión ya calculada', async () => {
    const { service, tx } = make({
      venue: { id: VENUE, name: 'Sala Aurora', homeTopUpEnabled: true, deletedAt: null, pausedAt: null, business: null, paymentMethods: null, serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1200 },
    });
    const view = await service.page(CODE, undefined);
    expect(tx.venue.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { homeTopUpCode: CODE } }));
    expect(view).toMatchObject({ venueName: 'Sala Aurora', problem: null, minCents: 1000, maxCents: 30000, serviceFeeBps: 1200, mine: null });
    expect(view?.feesCents).toHaveLength(291);
    expect(view?.feesCents?.[40]).toBe(600);
  });

  it('el terminal de la carga: uno del local que no sea el datáfono de recepción', async () => {
    const { service, tx } = make();
    await service.page(CODE, undefined);
    expect(tx.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: VENUE, active: true }, orderBy: [{ reception: 'asc' }, { externalId: 'asc' }] }),
    );
  });

  it('sin pasarela o sin terminal: la página dice que ahora no se puede', async () => {
    expect((await make({ gateways: 0 }).service.page(CODE, undefined))?.problem).toBe('gateway');
    expect((await make({ terminal: null }).service.page(CODE, undefined))?.problem).toBe('terminal');
  });

  it('«Ya tienes un saldo aquí»: el que recuerda el navegador, vivo, con dinero y de este local', async () => {
    const cookie = (
      rememberSetCookie(SECRET, { id: W1, qrToken: 'q1' }, rememberSetCookie(SECRET, { id: W2, qrToken: 'q2' }, undefined)?.split(';')[0]) ?? ''
    ).split(';')[0];
    const wallets = [
      { id: W1, qrToken: 'q1', shortCode: 'K7Q4M2', status: 'ACTIVE', balanceCents: 0, blockedAt: null, mergedIntoId: null, closeRequestedAt: null, pendingAssignAt: null },
      { id: W2, qrToken: 'q2', shortCode: 'Z9X8W7', status: 'DEPLETED', balanceCents: 0, blockedAt: null, mergedIntoId: null, closeRequestedAt: null, pendingAssignAt: null },
    ];
    const { service, tx } = make({ wallets });
    const view = await service.page(CODE, cookie);
    // El primero está a 0 sin haber pagado nunca (una carga sin pagar): no cuenta; el segundo, a cero (gastado), sí.
    expect(view?.mine).toEqual({ codeHint: 'Z9X-•••' });
    expect(tx.clientWallet.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [W1, W2] }, tenantId: VENUE } }));
    expect(await service.mySaldoHref(CODE, cookie, 'en')).toBe('/w/q2?lang=en#recargar');
  });

  it('tras un enlace nuevo del dueño (relink), la cookie de antes ya no lo ofrece ni lleva a su página', async () => {
    const cookie = (rememberSetCookie(SECRET, { id: W1, qrToken: 'enlace-viejo' }, undefined) ?? '').split(';')[0];
    const relinked = { id: W1, qrToken: 'enlace-nuevo', shortCode: 'K7Q4M2', status: 'ACTIVE', balanceCents: 5000, blockedAt: null, mergedIntoId: null, closeRequestedAt: null, pendingAssignAt: null };
    const { service } = make({ wallets: [relinked] });
    expect((await service.page(CODE, cookie))?.mine).toBeNull();
    expect(await service.mySaldoHref(CODE, cookie, 'es')).toBeNull();
  });

  it('bloqueado, sumado a otro, con «Me voy» o pendiente de asignar: no se ofrece', async () => {
    const cookie = (rememberSetCookie(SECRET, { id: W1, qrToken: 'q1' }, undefined) ?? '').split(';')[0];
    const base = { id: W1, qrToken: 'q1', shortCode: 'K7Q4M2', status: 'ACTIVE', balanceCents: 5000, blockedAt: null, mergedIntoId: null, closeRequestedAt: null, pendingAssignAt: null };
    for (const extra of [{ blockedAt: new Date() }, { mergedIntoId: W2 }, { closeRequestedAt: new Date() }, { pendingAssignAt: new Date() }, { status: 'REFUNDED' }]) {
      expect((await make({ wallets: [{ ...base, ...extra }] }).service.page(CODE, cookie))?.mine).toBeNull();
    }
    expect((await make({ wallets: [base] }).service.page(CODE, cookie))?.mine).toEqual({ codeHint: 'K7Q-•••' });
    // Sin cookie (o sin saldo que recuerde), nada; ni se mira la base.
    const none = make({ wallets: [base] });
    expect((await none.service.page(CODE, undefined))?.mine).toBeNull();
    expect(none.tx.clientWallet.findMany).not.toHaveBeenCalled();
    expect(await none.service.mySaldoHref(CODE, undefined, 'es')).toBeNull();
  });
});

describe('HomeTopUpService.start', () => {
  it('crea una recarga de un saldo NUEVO del local, sin persona ni propina, con la clave wcasa:', async () => {
    const { service, payments, redis } = make();
    const out = await start(service);
    expect(payments.create).toHaveBeenCalledWith(VENUE, homeTopUpKey(SECRET, VENUE, KEY), {
      amountCents: 5000,
      currency: 'EUR',
      terminalExternalId: 'T1',
      wallet: { create: true },
    });
    // Sin cuarto argumento: nadie del local la crea (nadie cobra comisión).
    expect((payments.create.mock.calls[0] as unknown[]).length).toBe(3);
    expect(out).toEqual({ payToken: 'payTok', payUrl: '/pay/payTok?lang=es' });
    // Una clave por ventana de 15 min (si su caducidad fallara, la siguiente es otra).
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^np:home-topup:venue:${VENUE}:[0-9]+$`)));
  });

  it('el enlace ya no vale: 404 HOME_TOPUP_GONE (sin crear nada)', async () => {
    const { service, payments } = make({ venue: null });
    const err = await start(service).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_GONE' });
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('importes como «Recargar»: euros enteros de 10 a 300 €', async () => {
    for (const amountCents of [999, 900, 30_100, 5050, '5000', null, 0, -1000]) {
      const { service, payments } = make();
      const err = await start(service, { amountCents }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_AMOUNT' });
      expect(payments.create).not.toHaveBeenCalled();
    }
    for (const amountCents of [1000, 30_000]) await expect(start(make().service, { amountCents })).resolves.toBeTruthy();
  });

  it('sin la clave del navegador (página vieja): 400 PAGE_STALE', async () => {
    const err = await start(make().service, { key: 'corta' }).catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'PAGE_STALE' });
  });

  it('el local en pausa: 423; formas de cobro apagadas: 409 PAYMENT_METHOD_DISABLED; sin pasarela: 409 HOME_TOPUP_UNAVAILABLE', async () => {
    const venue = { id: VENUE, name: 'x', homeTopUpEnabled: true, deletedAt: null, pausedAt: null, business: null, paymentMethods: null };
    const paused = await start(make({ venue: { ...venue, pausedAt: new Date() } }).service).catch((e: unknown) => e);
    expect((paused as HttpException).getStatus()).toBe(423);
    const off = await start(make({ venue: { ...venue, paymentMethods: { card: false } } }).service).catch((e: unknown) => e);
    expect((off as HttpException).getResponse()).toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' });
    const noGw = await start(make({ gateways: 0 }).service).catch((e: unknown) => e);
    expect(noGw).toBeInstanceOf(ConflictException);
    expect((noGw as ConflictException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_UNAVAILABLE', reason: 'gateway' });
  });

  it('freno del local: pasadas 60 cargas en 15 min, 429 HOME_TOPUP_BUSY; sin Redis, 503 TRY_LATER', async () => {
    const busy = make({ redisCount: 60 });
    const err = await start(busy.service).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_BUSY' });
    expect(busy.payments.create).not.toHaveBeenCalled();
    const down = await start(make({ redisFails: true }).service).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(ServiceUnavailableException);
    expect((down as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'TRY_LATER' });
  });

  it('tope de 24 h por IP: la 11.ª carga nueva en el local o la 31.ª sumando todos, 429 HOME_TOPUP_DAILY (sin crear nada)', async () => {
    const inVenue = make({ redisStart: dayStart(10, 0) });
    const err = await start(inVenue.service, { ip: IP }).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_DAILY' });
    expect(inVenue.payments.create).not.toHaveBeenCalled();
    // Una IP ya parada no gasta el freno del local.
    expect(inVenue.redis.incr).not.toHaveBeenCalledWith(expect.stringMatching(/^np:home-topup:venue:/));
    const inAll = make({ redisStart: dayStart(0, 30) });
    const err2 = await start(inAll.service, { ip: IP }).catch((e: unknown) => e);
    expect((err2 as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_DAILY' });
    // La 10.ª en el local y la 30.ª en todos aún pasan.
    await expect(start(make({ redisStart: dayStart(9, 29) }).service, { ip: IP })).resolves.toBeTruthy();
  });

  it('las cuentas del día: por la IP (su red /64 en IPv6), en este local y en todos, y caducan en 24 h', async () => {
    const { service, redis } = make();
    await start(service, { ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    expect(redis.incr).toHaveBeenCalledWith(`np:home-topup:ip-venue:${VENUE}:2001:db8:1:2::/64:${homeTopUpDay()}`);
    expect(redis.incr).toHaveBeenCalledWith(`np:home-topup:ip:2001:db8:1:2::/64:${homeTopUpDay()}`);
    expect(redis.expire).toHaveBeenCalledWith(`np:home-topup:ip:2001:db8:1:2::/64:${homeTopUpDay()}`, 24 * 3600);
  });

  it('una carga que no llega a empezar no gasta el día: parada por el tope, por el freno del local o por un fallo al crearla', async () => {
    const code = (e: unknown) => (e as HttpException).getResponse();
    // El freno del local (60 en 15 min): 429 BUSY, y el hueco del día vuelve.
    const busy = make({ redisStart: (k) => (k.startsWith('np:home-topup:venue:') ? 60 : undefined) });
    expect(code(await start(busy.service, { ip: IP }).catch((e: unknown) => e))).toMatchObject({ code: 'HOME_TOPUP_BUSY' });
    expect(busy.redis.decr).toHaveBeenCalledWith(expect.stringMatching(/^np:home-topup:ip-venue:/));
    expect(busy.redis.decr).toHaveBeenCalledWith(expect.stringMatching(/^np:home-topup:ip:/));
    // Un fallo al crear el cobro: también vuelve.
    const broken = make();
    broken.payments.create.mockRejectedValueOnce(new Error('pasarela caída'));
    await expect(start(broken.service, { ip: IP })).rejects.toThrow('pasarela caída');
    expect(broken.redis.decr).toHaveBeenCalledTimes(2);
    // Parada por el propio tope: lo que cogió vuelve (las cuentas no suben de más).
    const over = make({ redisStart: dayStart(10, 0) });
    expect(code(await start(over.service, { ip: IP }).catch((e: unknown) => e))).toMatchObject({ code: 'HOME_TOPUP_DAILY' });
    expect(over.redis.decr).toHaveBeenCalledTimes(2);
    // La que sí empieza se queda contada.
    const fine = make();
    await start(fine.service, { ip: IP });
    expect(fine.redis.decr).not.toHaveBeenCalled();
  });

  it('sin IP de fiar no se cuenta el día (como el freno de las IP); el del local, sí', async () => {
    const { service, redis } = make();
    await start(service, { ip: null });
    expect(redis.incr).toHaveBeenCalledTimes(1);
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^np:home-topup:venue:/));
  });

  it('20 en curso a la vez en el local (pago abierto o en el banco, de la última hora): 409 HOME_TOPUP_BUSY', async () => {
    const full = make({ unresolved: 20 });
    const before = Date.now();
    const err = await start(full.service).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_BUSY' });
    // Ni las ORPHAN (abandonadas a propósito no paran el enlace) ni las que lleven persona.
    expect(full.tx.payment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: VENUE,
        createdByUserId: null,
        idempotencyKey: { startsWith: 'wcasa:' },
        OR: [{ status: 'AUTHORIZING' }, { status: 'CREATED', qrExpiresAt: { gt: expect.any(Date) } }],
      }),
    });
    const since = (full.tx.payment.count.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where.createdAt.gte;
    expect(before - since.getTime()).toBeGreaterThanOrEqual(60 * 60_000 - 1000);
    expect(before - since.getTime()).toBeLessThan(60 * 60_000 + 5000);
    await expect(start(make({ unresolved: 19 }).service)).resolves.toBeTruthy();
  });

  it('la misma clave repetida (doble toque): el mismo cobro, sin gastar el freno', async () => {
    const { service, redis, tx, payments } = make({ replay: true, redisCount: 999, unresolved: 999 });
    await expect(start(service, { ip: IP })).resolves.toEqual({ payToken: 'payTok', payUrl: '/pay/payTok?lang=es' });
    expect(redis.incr).not.toHaveBeenCalled();
    expect(tx.payment.count).not.toHaveBeenCalled();
    expect(payments.create).toHaveBeenCalled();
  });

  it('la misma clave tarde (el cobro ya caducó o se pagó): 409 WALLET_TOPUP_STALE', async () => {
    for (const created of [{ status: 'EXPIRED' }, { status: 'CREATED', qrExpiresAt: new Date(Date.now() - 1000).toISOString() }]) {
      const err = await start(make({ replay: true, created }).service).catch((e: unknown) => e);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_STALE' });
    }
  });
});
