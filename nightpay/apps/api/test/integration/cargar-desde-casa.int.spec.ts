// Integración (Postgres real): «Cargar saldo antes de llegar». El enlace del
// local (/r/<código>) apagado de serie y con un código al azar que se cambia;
// la carga es una recarga con tarjeta de un saldo NUEVO (la maquinaria de
// siempre: se suma una vez al pagarse, sin persona ni comisión de nadie), con
// los importes de «Recargar», la comisión del servicio de las recargas, el
// freno del local y el tope de 24 h del saldo; el navegador que ya tiene un
// saldo de allí puede recargar ese; y en recepción se le da una ficha unida a
// ese saldo con su QR o con su PIN. np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { HttpException } from '@nestjs/common';
import { CobrosQuerySchema, serviceFeeQuote } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { CobrosService } from '../../src/modules/money-map/cobros.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { InvalidTransitionError } from '../../src/modules/payments/payment.machine';
import { cobrosCsv } from '../../src/modules/reports/export-csv';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { HomeTopUpService } from '../../src/modules/home-topup/home-topup.service';
import { HomeTopUpSettingsService } from '../../src/modules/home-topup/home-topup-settings.service';
import { ReceptionFichaService } from '../../src/modules/home-topup/reception-ficha.service';
import { fichaProof } from '../../src/modules/home-topup/ficha-qr';
import { rememberSetCookie, venueThrottleKey } from '../../src/modules/home-topup/home-topup-rules';

const SECRET = 'secreto-de-cookies-de-integracion-0123456789';
const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  duplicateCharges: { inc: vi.fn() },
};
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const counters = new Map<string, number>();
const redis = {
  incr: async (k: string) => {
    counters.set(k, (counters.get(k) ?? 0) + 1);
    return counters.get(k)!;
  },
  expire: async () => 1,
};
const config = { get: (k: string) => (k === 'COOKIE_SECRET' ? SECRET : undefined) };
const audit = { log: vi.fn(async () => undefined) };
const homeTopUps = new HomeTopUpService(prisma, payments, redis as never, config as never);
const settings = new HomeTopUpSettingsService(prisma, audit as never, homeTopUps, config as never);
const passkeys = { hasPasskey: vi.fn(async () => false), assertOwner: vi.fn(async () => undefined) };
const selfTopUps = new WalletTopUpService(prisma as never, passkeys as never, redis as never, config as never, { get: () => payments } as never);
const charges = new WalletChargesService(prisma, audit as never, { get: () => null } as never, {} as never);
const fichas = new ReceptionFichaService(prisma, charges, audit as never, config as never);
const period = new PeriodReportsService(prisma as never);
const cobros = new CobrosService(prisma);
const reports = new ReportsService(prisma);

/** Como una petición pública (sin local ni persona en el contexto). */
const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-casa' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string;
let B: string;
let barTerm: string;
let codeA: string;
let reception: { userId: string; role: 'WAITER'; tenantId: string };
let barman: { userId: string; role: 'WAITER'; tenantId: string };
let manager: { userId: string; role: 'MANAGER'; tenantId: string };
const owner = () => ({ userId: randomUUID(), tenantId: A });

const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
const startIn = (code: string, amountCents = 5000, k = key()) => pub(() => homeTopUps.start(code, { amountCents, key: k, lang: 'es', ip: null }));
const paymentOf = (payToken: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: payToken } }));
const walletOf = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));

/** El cliente fue al banco y el banco lo aprobó (el aviso). */
async function payAtBank(paymentId: string, tenantId: string, order: string, chargedCents: number): Promise<void> {
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({
      data: { paymentId, tenantId, provider: 'REDSYS', providerTxId: order, amountCents: chargedCents, tipCents: 0, claimHash: 'c'.repeat(64) },
    });
  });
  await approve(paymentId, order);
}
const approve = (paymentId: string, order: string) =>
  pub(() => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));

let loads = 0;

/** Una carga pagada: el saldo nuevo con su dinero. El pedido, único (12 caracteres, como en Redsys). */
async function paidLoad(code: string, amountCents = 5000): Promise<{ paymentId: string; payToken: string; walletId: string }> {
  const out = await startIn(code, amountCents);
  const p = await paymentOf(out.payToken);
  loads += 1;
  await payAtBank(p.id, p.tenantId, `RC${r}${String(loads).padStart(4, '0')}`, amountCents + p.serviceFeeCents);
  return { paymentId: p.id, payToken: out.payToken, walletId: p.walletId! };
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Casa', slug: `casa-${r}`, walletGroup: `gcasa-${r}` } })).id;
    // El datáfono de recepción va primero por nombre: la carga no se apunta a él.
    await tx.terminal.create({ data: { tenantId: A, externalId: `A-REC-${r}`, label: 'Recepción', zone: 'RECEPCION', reception: true } });
    barTerm = (await tx.terminal.create({ data: { tenantId: A, externalId: `B-BAR-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    B = (
      await tx.venue.create({
        data: { name: 'Sala Comisión', slug: `casaf-${r}`, walletGroup: `gcasaf-${r}`, serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1200 },
      })
    ).id;
    await tx.terminal.create({ data: { tenantId: B, externalId: `TF-${r}`, label: 'Barra', zone: 'BARRA' } });
    await tx.gatewayCredential.create({
      data: { tenantId: B, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    const user = (role: 'WAITER' | 'MANAGER', post: string | null, tag: string) =>
      tx.user.create({ data: { tenantId: A, email: `${tag}-casa-${r}@x.es`, passwordHash: 'x', role, ...(post ? { post } : {}) } as never });
    reception = { userId: (await user('WAITER', 'RECEPCION', 'rec')).id, role: 'WAITER', tenantId: A };
    barman = { userId: (await user('WAITER', 'BARRA', 'bar')).id, role: 'WAITER', tenantId: A };
    manager = { userId: (await user('MANAGER', null, 'enc')).id, role: 'MANAGER', tenantId: A };
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('el interruptor y el enlace del local', () => {
  it('apagado de serie: sin enlace; un código cualquiera da 404 sin pistas (igual que uno que no existe)', async () => {
    expect(await pub(() => settings.view(A))).toMatchObject({ enabled: false, url: null, qrPngDataUrl: null });
    expect(await pub(() => homeTopUps.page('AbCdEfGhIjKlMnOp', undefined))).toBeNull();
    const err = await startIn('AbCdEfGhIjKlMnOp').catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_GONE' });
  });

  it('encendido: el enlace con su código al azar y la página del local', async () => {
    const view = await pub(() => settings.setEnabled(owner(), true));
    expect(view.enabled).toBe(true);
    codeA = (view.url ?? '').split('/r/')[1] ?? '';
    expect(codeA).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(codeA).not.toContain(A.slice(0, 8));
    expect(view.qrPngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(await pub(() => homeTopUps.page(codeA, undefined))).toMatchObject({ venueName: 'Sala Casa', problem: null, serviceFeeBps: null, mine: null });
  });

  it('apagado otra vez: el mismo código da 404 (y no se carga); al encender, vuelve el mismo enlace', async () => {
    await pub(() => settings.setEnabled(owner(), false));
    expect(await pub(() => homeTopUps.page(codeA, undefined))).toBeNull();
    expect(((await startIn(codeA).catch((e: unknown) => e)) as HttpException).getStatus()).toBe(404);
    const again = await pub(() => settings.setEnabled(owner(), true));
    expect(again.url?.endsWith(`/r/${codeA}`)).toBe(true);
  });

  it('«Enlace nuevo»: el código de antes deja de valer al momento; el nuevo, sí', async () => {
    const old = codeA;
    const view = await pub(() => settings.rotate(owner()));
    codeA = (view.url ?? '').split('/r/')[1] ?? '';
    expect(codeA).not.toBe(old);
    expect(await pub(() => homeTopUps.page(old, undefined))).toBeNull();
    expect(((await startIn(old).catch((e: unknown) => e)) as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_GONE' });
    expect(await pub(() => homeTopUps.page(codeA, undefined))).not.toBeNull();
  });

  it('la base no deja un código raro ni encenderlo sin código', async () => {
    await expect(sys((tx) => tx.venue.update({ where: { id: A }, data: { homeTopUpCode: 'corto' } }))).rejects.toThrow();
    await expect(sys((tx) => tx.venue.update({ where: { id: B }, data: { homeTopUpEnabled: true, homeTopUpCode: null } }))).rejects.toThrow();
  });
});

describe('el cartel de la cola (B16)', () => {
  it('desde el wifi del local (una sola IP): más cargas que el tope por IP, con el tope por móvil', async () => {
    const poster = await pub(() => settings.queuePoster(A));
    const token = decodeURIComponent(poster!.url.split('cola=')[1]!);
    const WIFI = '198.51.100.20';
    const fromQueue = (deviceId: string | null, t: unknown = token) =>
      pub(() => homeTopUps.start(codeA, { amountCents: 1000, key: key(), lang: 'es', ip: WIFI, queue: { token: t, deviceId } }));
    // 11 móviles distintos tras la misma IP: pasa del tope de 24 h por IP (10) sin tocarlo.
    for (let i = 0; i < 11; i += 1) await expect(fromQueue(`dev-${r}-${i}`)).resolves.toMatchObject({ payUrl: expect.stringMatching(/^[/]pay[/]/) });
    expect([...counters.keys()].some((k) => k.includes(WIFI))).toBe(false);
    // El mismo móvil, como mucho 3 por noche.
    const same = `dev-${r}-same`;
    for (let i = 0; i < 3; i += 1) await fromQueue(same);
    await expect(fromQueue(same)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'HOME_TOPUP_QUEUE_DEVICE' }) });
    // Un QR inventado o sin la cookie del móvil: no.
    await expect(fromQueue(`dev-${r}-x`, '1.AAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'HOME_TOPUP_QUEUE_EXPIRED' }) });
    await expect(fromQueue(null)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'HOME_TOPUP_QUEUE_COOKIE' }) });
  });
});

describe('la carga: un saldo nuevo del local', () => {
  it('recarga con tarjeta de un saldo NUEVO: sin persona, sin propina, al terminal que no es de recepción', async () => {
    const before = await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }));
    const k = key();
    const out = await startIn(codeA, 5000, k);
    const p = await paymentOf(out.payToken);
    expect(p).toMatchObject({
      tenantId: A,
      terminalId: barTerm,
      status: 'CREATED',
      amountCents: 5000,
      tipCents: 0,
      serviceFeeCents: 0,
      serviceFeeBps: null,
      captureMethod: 'WALLET_TOPUP',
      createdByUserId: null,
      operatorCommissionBps: null,
    });
    expect(p.idempotencyKey).toMatch(/^wcasa:[0-9a-f]{64}$/);
    expect(out.payUrl).toBe(`/pay/${out.payToken}?lang=es`);
    const w = await walletOf(p.walletId!);
    expect(w).toMatchObject({ tenantId: A, status: 'ACTIVE', balanceCents: 0, walletGroup: `gcasa-${r}` });
    expect(w.shortCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }))).toBe(before + 1);
    // Doble toque (la misma clave): el mismo cobro, sin otro saldo.
    expect((await startIn(codeA, 5000, k)).payToken).toBe(out.payToken);
    expect(await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }))).toBe(before + 1);
    // La página de pago de siempre, sin propina.
    await expect(pub(() => payments.getPayPage(out.payToken))).resolves.toMatchObject({ kind: 'choose', tipMaxCents: 0 });
  });

  it('el aviso del banco que llega dos veces: el saldo se suma una sola vez y nadie cobra comisión', async () => {
    const out = await startIn(codeA, 7000);
    const p = await paymentOf(out.payToken);
    await payAtBank(p.id, A, `RD${r}1`, 7000);
    expect(await walletOf(p.walletId!)).toMatchObject({ balanceCents: 7000, status: 'ACTIVE' });
    await expect(approve(p.id, `RD${r}1`)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await walletOf(p.walletId!)).balanceCents).toBe(7000);
    expect(await sys((tx) => tx.operatorEarning.count({ where: { paymentId: p.id } }))).toBe(0);
    // Pagada: su navegador va a su saldo nuevo con la bienvenida (con el saldo y su código).
    const paid = await pub(() => payments.getPayPage(out.payToken));
    const w = await walletOf(p.walletId!);
    expect(paid).toMatchObject({ kind: 'paid', walletToken: w.qrToken, walletFromHome: true });
    expect(paid).toMatchObject({ walletCode: `${w.shortCode?.slice(0, 3)}-${w.shortCode?.slice(3)}` });
  });

  it('importes como «Recargar»: euros enteros de 10 a 300 €', async () => {
    for (const cents of [500, 999, 5050, 30_100]) {
      const err = await startIn(codeA, cents).catch((e: unknown) => e);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_AMOUNT' });
    }
    await expect(startIn(codeA, 1000)).resolves.toBeTruthy();
    await expect(startIn(codeA, 30_000)).resolves.toBeTruthy();
  });

  it('el tope de 24 h del saldo cuenta la carga desde casa: 300 € + 300 € desde /w y no cabe nada más', async () => {
    const load = await paidLoad(codeA, 30_000);
    const w = await walletOf(load.walletId);
    const second = await pub(() => selfTopUps.start(w.qrToken, { amountCents: 30_000, key: key(), lang: 'es' }, 'api.test'));
    const p2 = await paymentOf(second.payToken);
    await payAtBank(p2.id, A, `RT${r}2`, 30_000);
    const err = await pub(() => selfTopUps.start(w.qrToken, { amountCents: 1000, key: key(), lang: 'es' }, 'api.test')).catch((e: unknown) => e);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_DAILY_LIMIT' });
  });

  it('informes: cuentan como recargas con tarjeta (dinero que entra), no como ventas', async () => {
    const from = new Date(Date.now() - 3600_000);
    const z = await cls.run(async () => {
      cls.set('ctx', { traceId: 't', acrossVenues: true });
      return prisma.asSystem(() => period.periodZ(A, { from, to: new Date(Date.now() + 60_000) }));
    });
    const paidTopUps = await sys((tx) =>
      tx.payment.aggregate({ where: { tenantId: A, walletId: { not: null }, status: 'AUTHORIZED' }, _sum: { amountCents: true }, _count: true }),
    );
    expect(paidTopUps._count).toBeGreaterThanOrEqual(3);
    expect(z.wallet.topUpCount).toBe(paidTopUps._count);
    expect(z.wallet.topUpCents).toBe(paidTopUps._sum.amountCents);
    expect(z.byRevenueCategory).toEqual([]);
  });

  it('el panel (Cobros) y el libro de cobros la marcan «Desde casa», sin la clave; una del personal con esa clave, no', async () => {
    const load = await paidLoad(codeA, 2000);
    // Una venta del personal con una clave de la misma forma (puesta a mano): no es del enlace.
    const staff = await sys((tx) =>
      tx.payment.create({
        data: {
          tenantId: A,
          terminalId: barTerm,
          idempotencyKey: `wcasa:${randomBytes(32).toString('hex')}`,
          amountCents: 3000,
          availableAmountCents: 3000,
          qrToken: `casa-personal-${r}`,
          qrExpiresAt: new Date(Date.now() + 3600_000),
          status: 'AUTHORIZED',
          authorizedAt: new Date(),
          createdByUserId: reception.userId,
          revenueCategory: 'VENUE_BAR',
        },
      }),
    );
    const inA = <T>(fn: () => Promise<T>): Promise<T> =>
      cls.run(async () => {
        cls.set('ctx', { tenantId: A, traceId: 't-casa' });
        return fn();
      });

    // El panel: la carga sale «Desde casa» (sin persona); la del personal, no. Ninguna lleva la clave.
    const [home] = (await inA(() => cobros.list(A, CobrosQuerySchema.parse({ walletId: load.walletId })))).items;
    expect(home).toMatchObject({ kind: 'PAYMENT', id: load.paymentId, isTopUp: true, person: null, fromHome: true });
    const mine = await inA(() => cobros.list(A, CobrosQuerySchema.parse({ operatorId: reception.userId })));
    const byStaff = mine.items.find((i) => i.id === staff.id);
    expect(byStaff).toBeDefined();
    expect(byStaff).not.toHaveProperty('fromHome');
    expect(JSON.stringify([home, byStaff])).not.toMatch(/wcasa:|idempotencyKey|createdByUserId/);

    // El libro de cobros de la gestoría: «Origen», la última; «Desde casa» en la carga y vacía en la del personal.
    const rows = await inA(() => reports.cobros(A, { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) }));
    const csv = cobrosCsv(rows, 'Sala Casa');
    const [header, ...body] = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    const cols = header!.split(';');
    expect(cols.at(-1)).toBe('Origen');
    const origin = (id: string) => body.find((l) => l.includes(id))?.split(';')[cols.indexOf('Origen')];
    expect(origin(load.paymentId)).toBe('Desde casa');
    expect(origin(staff.id)).toBe('');
    expect(csv).not.toContain('wcasa:');
  });
});

describe('la comisión del servicio de las recargas', () => {
  let codeB: string;
  beforeAll(async () => {
    const view = await pub(() => settings.setEnabled({ userId: randomUUID(), tenantId: B }, true));
    codeB = (view.url ?? '').split('/r/')[1] ?? '';
    expect(view.serviceFeeBps).toBe(1200);
  });

  it('encendida: lo que enseña la página es lo que cobra el servidor; al saldo va solo lo cargado', async () => {
    const page = await pub(() => homeTopUps.page(codeB, undefined));
    for (const euros of [10, 33, 57, 299, 300]) {
      const cents = euros * 100;
      const out = await startIn(codeB, cents);
      const p = await paymentOf(out.payToken);
      const fee = serviceFeeQuote({ enabled: true, cardBps: 1000, topUpBps: 1200 }, 'topUp', cents).feeCents;
      expect(page?.feesCents?.[(cents - 1000) / 100]).toBe(fee);
      expect(p).toMatchObject({ amountCents: cents, serviceFeeCents: fee, serviceFeeBps: 1200, availableAmountCents: cents, platformCommissionBps: 0 });
    }
    const load = await paidLoad(codeB, 5000);
    expect((await walletOf(load.walletId)).balanceCents).toBe(5000);
    expect((await sys((tx) => tx.payment.findUniqueOrThrow({ where: { id: load.paymentId } }))).serviceFeeCents).toBe(600);
  });
});

describe('el freno del local', () => {
  it('20 a medias a la vez: la siguiente, 409 HOME_TOPUP_BUSY; caducadas, no cuentan', async () => {
    const open = await sys((tx) =>
      tx.payment.count({ where: { tenantId: A, idempotencyKey: { startsWith: 'wcasa:' }, status: 'CREATED', qrExpiresAt: { gt: new Date() } } }),
    );
    const started: string[] = [];
    for (let i = open; i < 20; i += 1) started.push((await startIn(codeA, 1000)).payToken);
    const err = await startIn(codeA, 1000).catch((e: unknown) => e);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_BUSY' });
    // El cliente no pagó: caducan (y su saldo vacío se cierra) y ya caben.
    const all = await sys((tx) =>
      tx.payment.findMany({ where: { tenantId: A, idempotencyKey: { startsWith: 'wcasa:' }, status: 'CREATED' }, select: { id: true, walletId: true } }),
    );
    for (const p of all) await pub(() => payments.transition(p.id, { type: 'TIMEOUT' }));
    expect((await walletOf(all[0]!.walletId!)).status).toBe('EXPIRED');
    await expect(startIn(codeA, 1000)).resolves.toBeTruthy();
  });

  it('60 cargas empezadas en 15 min en el local: 429 HOME_TOPUP_BUSY', async () => {
    counters.set(venueThrottleKey(A), 60);
    const err = await startIn(codeA, 1000).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_BUSY' });
    counters.delete(venueThrottleKey(A));
  });
});

describe('este navegador ya tiene un saldo del local', () => {
  it('lo ofrece (con su código tapado) y «Recargar mi saldo» lleva a su página, en «Recargar»', async () => {
    const load = await paidLoad(codeA, 2000);
    const w = await walletOf(load.walletId);
    const cookie = (rememberSetCookie(SECRET, { id: w.id, qrToken: w.qrToken }, undefined) ?? '').split(';')[0];
    const page = await pub(() => homeTopUps.page(codeA, cookie));
    expect(page?.mine).toEqual({ codeHint: `${w.shortCode?.slice(0, 3)}-•••` });
    expect(await pub(() => homeTopUps.mySaldoHref(codeA, cookie, 'fr'))).toBe(`/w/${w.qrToken}?lang=fr#recargar`);
  });

  it('no ofrece un saldo sin pagar, de otro local ni uno bloqueado', async () => {
    const unpaid = await paymentOf((await startIn(codeA, 1000)).payToken);
    const otherVenue = await paidLoad((await pub(() => settings.view(B))).url!.split('/r/')[1]!, 1000);
    const blocked = await paidLoad(codeA, 1000);
    await sys((tx) => tx.clientWallet.update({ where: { id: blocked.walletId }, data: { blockedAt: new Date() } }));
    let cookie = '';
    for (const id of [unpaid.walletId!, otherVenue.walletId, blocked.walletId]) {
      const w = await walletOf(id);
      cookie = (rememberSetCookie(SECRET, { id, qrToken: w.qrToken }, cookie) ?? '').split(';')[0] ?? '';
    }
    expect((await pub(() => homeTopUps.page(codeA, cookie)))?.mine).toBeNull();
    expect(await pub(() => homeTopUps.mySaldoHref(codeA, cookie, 'es'))).toBeNull();
  });

  it('tras un enlace nuevo del dueño (relink), la cookie de antes ya no lo ofrece ni lleva al enlace nuevo', async () => {
    const load = await paidLoad(codeA, 2000);
    const before = await walletOf(load.walletId);
    const cookie = (rememberSetCookie(SECRET, { id: before.id, qrToken: before.qrToken }, undefined) ?? '').split(';')[0];
    expect((await pub(() => homeTopUps.page(codeA, cookie)))?.mine).not.toBeNull();
    await sys((tx) => tx.clientWallet.update({ where: { id: before.id }, data: { qrToken: `relink-${r}-${randomUUID()}` } }));
    expect((await pub(() => homeTopUps.page(codeA, cookie)))?.mine).toBeNull();
    expect(await pub(() => homeTopUps.mySaldoHref(codeA, cookie, 'es'))).toBeNull();
  });
});

describe('al llegar: la ficha en recepción', () => {
  let n = 0;
  async function stockCard(): Promise<{ token: string; uid: string }> {
    n += 1;
    const token = `casa-ficha-${r}-${n}-0123456789`;
    const uid = `04A1B2${r.toUpperCase().replace(/[^0-9A-F]/g, '0').slice(0, 4)}${String(n).padStart(4, '0')}`;
    await sys((tx) => tx.walletCard.create({ data: { token, uid, status: 'STOCK', venueId: A, stockedAt: new Date() } }));
    return { token, uid };
  }

  /** La prueba del QR de la ficha que enseña ahora su página del saldo. */
  const proofOf = async (walletId: string) => {
    const w = await walletOf(walletId);
    return fichaProof(SECRET, { id: w.id, qrToken: w.qrToken });
  };

  it('con el QR de su saldo: recepción le da la ficha, unida a ese saldo; otra vez, no', async () => {
    const load = await paidLoad(codeA, 4000);
    const card = await stockCard();
    const proof = await proofOf(load.walletId);
    const out = await pub(() =>
      fichas.give(reception, { walletId: load.walletId, card: card.token, uid: card.uid, proof }),
    );
    expect(out).toMatchObject({ walletId: load.walletId, balanceCents: 4000, via: 'qr' });
    expect(out.fichaNumber).toEqual(expect.any(Number));
    expect(await sys((tx) => tx.walletCard.findUniqueOrThrow({ where: { token: card.token } }))).toMatchObject({
      walletId: load.walletId,
      status: 'ISSUED',
      linkedById: reception.userId,
    });
    const another = await stockCard();
    const err = await pub(() =>
      fichas.give(reception, { walletId: load.walletId, card: another.token, uid: another.uid, proof }),
    ).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(409);
  });

  it('solo la primera: con la ficha bloqueada (la perdió), recepción no da otra con su QR; el encargado, sí', async () => {
    const load = await paidLoad(codeA, 2500);
    const first = await stockCard();
    const proof = await proofOf(load.walletId);
    await pub(() => fichas.give(reception, { walletId: load.walletId, card: first.token, uid: first.uid, proof }));
    await pub(() => charges.blockCard({ userId: manager.userId, role: 'MANAGER', tenantId: A }, load.walletId));
    const next = await stockCard();
    const err = await pub(() => fichas.give(reception, { walletId: load.walletId, card: next.token, uid: next.uid, proof })).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(409);
    expect((err as Error).message).toContain('ya tuvo ficha');
    await expect(pub(() => fichas.give(manager, { walletId: load.walletId, card: next.token, uid: next.uid }))).resolves.toMatchObject({ via: 'manager' });
  });

  it('el QR de antes de un enlace nuevo del dueño ya no vale; el de su página de ahora, sí', async () => {
    const load = await paidLoad(codeA, 1500);
    const old = await proofOf(load.walletId);
    await sys((tx) => tx.clientWallet.update({ where: { id: load.walletId }, data: { qrToken: `relink-f-${r}-${randomUUID()}` } }));
    const card = await stockCard();
    const err = await pub(() => fichas.give(reception, { walletId: load.walletId, card: card.token, uid: card.uid, proof: old })).catch((e: unknown) => e);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_WRONG' });
    const now = await proofOf(load.walletId);
    await expect(pub(() => fichas.give(reception, { walletId: load.walletId, card: card.token, uid: card.uid, proof: now }))).resolves.toMatchObject({ via: 'qr' });
  });

  it('con su código y su PIN (los fallos cuentan); sin prueba, no; el encargado, sin prueba', async () => {
    const load = await paidLoad(codeA, 3000);
    await pub(() => charges.setPinFromPayer(load.walletId, '2468'));
    const card = await stockCard();
    const wrong = await pub(() => fichas.give(reception, { walletId: load.walletId, card: card.token, uid: card.uid, pin: '1357' })).catch(
      (e: unknown) => e,
    );
    expect((wrong as HttpException).getStatus()).toBe(422);
    expect((await walletOf(load.walletId)).pinFails).toBe(1);
    const none = await pub(() => fichas.give(reception, { walletId: load.walletId, card: card.token, uid: card.uid })).catch((e: unknown) => e);
    expect((none as HttpException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_REQUIRED' });
    await expect(pub(() => fichas.give(reception, { walletId: load.walletId, card: card.token, uid: card.uid, pin: '2468' }))).resolves.toMatchObject({
      via: 'pin',
    });
    const other = await paidLoad(codeA, 1000);
    const c2 = await stockCard();
    await expect(pub(() => fichas.give(manager, { walletId: other.walletId, card: c2.token, uid: c2.uid }))).resolves.toMatchObject({ via: 'manager' });
  });

  it('los mismos permisos que la recepción: un camarero de barra no da fichas', async () => {
    const load = await paidLoad(codeA, 1000);
    const card = await stockCard();
    const proof = await proofOf(load.walletId);
    const err = await pub(() =>
      fichas.give(barman, { walletId: load.walletId, card: card.token, uid: card.uid, proof }),
    ).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(403);
  });
});
