// Integración (Postgres real): «Regala una noche». En el enlace del local
// (/r/<código>), «Para regalar» (apagado de serie): quien regala paga un saldo
// nuevo de ese local con la carga de siempre (/pay), pero nunca se lleva el
// saldo, solo el enlace del regalo. Quien lo recibe lo guarda en su móvil con
// el QR de activación de siempre (aquí, con un PIN) y desde entonces el enlace
// del regalo ya no da nada. Tabla wallet_gifts con FORCE RLS: otro local no la
// ve. np_app (sin superusuario). Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { HomeTopUpService } from '../../src/modules/home-topup/home-topup.service';
import { HomeTopUpSettingsService } from '../../src/modules/home-topup/home-topup-settings.service';
import { HomeTopUpGiftService } from '../../src/modules/home-topup/home-topup-gift.service';
import { GIFT_TEXT_KEEP_DAYS, eraseGiftTexts } from '../../src/modules/home-topup/home-topup-gift';
import { isGiftPaymentKey } from '../../src/modules/home-topup/home-topup-rules';
import { WalletActivationUseService } from '../../src/modules/wallets/wallet-activation-use.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { WalletPasskeysService } from '../../src/modules/wallets/wallet-passkeys.service';

const SECRET = 'secreto-de-cookies-de-integracion-0123456789';
const DAY = 86_400_000;
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
  decr: async (k: string) => {
    counters.set(k, (counters.get(k) ?? 0) - 1);
    return counters.get(k)!;
  },
  expire: async () => 1,
};
const config = { get: (k: string) => (k === 'COOKIE_SECRET' ? SECRET : k === 'NEXT_PUBLIC_API_URL' ? 'https://api.regalo.test' : undefined) };
const audit = { log: vi.fn(async () => undefined) };
const homeTopUps = new HomeTopUpService(prisma, payments, redis as never, config as never);
const settings = new HomeTopUpSettingsService(prisma, audit as never, homeTopUps, config as never);
const gifts = new HomeTopUpGiftService(prisma, config as never);
const passkeys = new WalletPasskeysService(prisma, createFakeRedis() as never);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, { isEnabled: async () => true, assertForUser: async () => undefined } as never);
const uses = new WalletActivationUseService(prisma, passkeys, charges, audit as never);

/** Como una petición pública (sin local ni persona en el contexto). */
const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-regalo' });
    return fn();
  });
const inVenue = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-regalo-local' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string;
let B: string;
let codeA: string;
let codeB: string;
const owner = (tenantId: string) => ({ userId: randomUUID(), tenantId });
const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
const giftIn = (code: string, amountCents = 5000, g: { name?: unknown; message?: unknown } = { name: 'Lucía', message: 'Feliz cumple' }) =>
  pub(() => homeTopUps.start(code, { amountCents, key: key(), lang: 'es', ip: null, gift: { name: g.name, message: g.message } }));
const paymentOf = (payToken: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: payToken } }));
const giftOfPayment = (paymentId: string) => sys((tx) => tx.walletGift.findUniqueOrThrow({ where: { paymentId } }));

let orders = 0;
/** El cliente fue al banco y el banco lo aprobó (el aviso), como en cargar-desde-casa. */
async function payAtBank(paymentId: string, tenantId: string, chargedCents: number): Promise<void> {
  orders += 1;
  const order = `RG${r}${String(orders).padStart(4, '0')}`;
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { provider: 'REDSYS', providerTxId: order } });
    await tx.paymentAttempt.create({
      data: { paymentId, tenantId, provider: 'REDSYS', providerTxId: order, amountCents: chargedCents, tipCents: 0, claimHash: 'c'.repeat(64) },
    });
  });
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

/** Un regalo pagado: su cobro, su saldo y su enlace. */
async function paidGift(code: string, tenantId: string, amountCents = 5000) {
  const out = await giftIn(code, amountCents);
  const p = await paymentOf(out.payToken);
  await payAtBank(p.id, tenantId, amountCents + p.serviceFeeCents);
  const gift = await giftOfPayment(p.id);
  return { payToken: out.payToken, paymentId: p.id, walletId: p.walletId!, token: gift.token };
}

const activationToken = (path: string) => path.split('/w/a/')[1]!;

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    for (const [name, tag] of [
      ['Sala Regalo', 'a'],
      ['Sala Otra', 'b'],
    ] as const) {
      const id = (await tx.venue.create({ data: { name, slug: `regalo-${tag}-${r}`, walletGroup: `gregalo-${r}` } })).id;
      await tx.terminal.create({ data: { tenantId: id, externalId: `RG-${tag}-${r}`, label: 'Barra', zone: 'BARRA' } });
      await tx.gatewayCredential.create({
        data: { tenantId: id, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
      });
      if (tag === 'a') A = id;
      else B = id;
    }
  });
  codeA = ((await pub(() => settings.setEnabled(owner(A), true))).url ?? '').split('/r/')[1]!;
  codeB = ((await pub(() => settings.setEnabled(owner(B), true))).url ?? '').split('/r/')[1]!;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Regalos»: apagado de serie', () => {
  it('apagado: «Para regalar» no sale y comprar un regalo da 404 sin pistas (la carga normal, sí)', async () => {
    const view = await pub(() => settings.view(A));
    expect(view).toMatchObject({ enabled: true, giftsEnabled: false, gifts: [] });
    expect((await pub(() => homeTopUps.page(codeA, undefined)))?.gifts).toBeUndefined();
    const before = await sys((tx) => tx.payment.count({ where: { tenantId: A } }));
    const err = await giftIn(codeA).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'HOME_TOPUP_GONE' });
    expect(await sys((tx) => tx.payment.count({ where: { tenantId: A } }))).toBe(before);
  });

  it('encendido por el dueño (queda en el registro): la página ofrece «Para regalar»', async () => {
    const view = await pub(() => settings.setGifts(owner(A), true));
    expect(view.giftsEnabled).toBe(true);
    expect((await pub(() => homeTopUps.page(codeA, undefined)))?.gifts).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'venue.home_topup.gifts_updated', tenantId: A }));
  });
});

describe('comprar → pagar → guardar: quien regaló ya no tiene nada', () => {
  let g: Awaited<ReturnType<typeof paidGift>>;

  it('comprar: el cobro de siempre (recarga de un saldo nuevo, «Desde casa»), los mismos topes, y el regalo con su enlace', async () => {
    // Los mismos importes que una carga.
    const err = await giftIn(codeA, 30100).catch((e: unknown) => e);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'WALLET_TOPUP_AMOUNT' });
    const long = await giftIn(codeA, 5000, { message: 'x'.repeat(121) }).catch((e: unknown) => e);
    expect((long as HttpException).getResponse()).toMatchObject({ code: 'GIFT_TEXT' });

    g = await paidGift(codeA, A);
    const p = await paymentOf(g.payToken);
    expect(isGiftPaymentKey(p.idempotencyKey)).toBe(true);
    expect(p).toMatchObject({ status: 'AUTHORIZED', amountCents: 5000, createdByUserId: null });
    const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: g.walletId } }));
    // Saldo de ese local, sin grupo, con el dinero ya sumado.
    expect(wallet).toMatchObject({ tenantId: A, balanceCents: 5000, walletGroup: null, pinHash: null });
    const row = await giftOfPayment(g.paymentId);
    expect(row).toMatchObject({ tenantId: A, walletId: g.walletId, toName: 'Lucía', message: 'Feliz cumple', claimedAt: null });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(90 * DAY);
    expect(row.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(row.token).not.toBe(wallet.qrToken);
  });

  it('pagado: quien regaló no se lleva el saldo (ni enlace, ni código, ni Face ID o PIN), solo «Comparte tu regalo»', async () => {
    const page = await pub(() => payments.getPayPage(g.payToken));
    expect(page).toMatchObject({ kind: 'paid', walletToken: null, walletCode: null, gift: true });
    expect(page).not.toHaveProperty('walletFromHome');
    expect(await pub(() => payments.giftToken(g.paymentId))).toBe(g.token);
    // Ni la vía del «móvil que pagó» en la página del saldo.
    expect(await pub(() => uses.payerBase(g.walletId))).toBeNull();
    const view = await pub(() => gifts.view(g.token));
    expect(view).toMatchObject({ state: 'open', venueName: 'Sala Regalo', amountCents: 5000, toName: 'Lucía', message: 'Feliz cumple' });
  });

  it('el panel lo lista sin guardar (sin el nombre ni el mensaje)', async () => {
    const view = await pub(() => settings.view(A));
    const row = view.gifts.find((x) => x.amountCents === 5000 && x.state === 'open');
    expect(row).toBeDefined();
    expect(JSON.stringify(view.gifts)).not.toContain('Lucía');
  });

  it('«Guardar en mi móvil» y su PIN: guardado en la misma transacción; el enlace del regalo ya no da nada, ni la segunda vez', async () => {
    // Quien regaló pulsa antes (o reenvía el enlace): un QR que el de quien lo recibe anula.
    const first = await pub(() => gifts.claim(g.token));
    const friend = await pub(() => gifts.claim(g.token));
    if (!first || !('activationPath' in first) || !friend || !('activationPath' in friend)) throw new Error('sin QR');
    await expect(pub(() => uses.setPin(activationToken(first.activationPath), '4827'))).rejects.toMatchObject({ response: { code: 'ACTIVATION_EXPIRED' } });
    const saved = await pub(() => uses.setPin(activationToken(friend.activationPath), '7395'));
    expect(saved.walletId).toBe(g.walletId);
    const row = await giftOfPayment(g.paymentId);
    expect(row.claimedAt).not.toBeNull();
    // El saldo de quien lo guardó, con su enlace nuevo (el de antes ya no vale).
    const wallet = await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: g.walletId } }));
    expect(wallet.qrToken).toBe(saved.qrToken);
    expect(wallet.pinHash).not.toBeNull();
    expect(wallet.balanceCents).toBe(5000);

    // Quien regaló (o cualquiera con el enlace): «Este regalo ya se ha guardado», y ningún QR más.
    expect((await pub(() => gifts.view(g.token)))?.state).toBe('claimed');
    expect(await pub(() => gifts.claim(g.token))).toEqual({ state: 'claimed' });
    expect(await pub(() => gifts.claim(g.token))).toEqual({ state: 'claimed' });
    const live = await sys((tx) => tx.walletActivationToken.count({ where: { walletId: g.walletId, usedAt: null, revokedAt: null } }));
    expect(live).toBe(0);
    // Y el /pay de quien pagó sigue sin dar el saldo.
    expect(await pub(() => payments.getPayPage(g.payToken))).toMatchObject({ kind: 'paid', walletToken: null });
    expect((await pub(() => settings.view(A))).gifts.find((x) => x.id === row.id)?.state).toBe('claimed');
  });

  it('un QR del regalo emitido antes de guardarlo y sin anular (dos «Guardar» a la vez) ya no activa nada después', async () => {
    const h = await paidGift(codeA, A, 2500);
    const a = await pub(() => gifts.claim(h.token));
    if (!a || !('activationPath' in a)) throw new Error('sin QR');
    // Como si otro QR se hubiera emitido a la vez y no se hubiera anulado: se guarda con a…
    await pub(() => uses.setPin(activationToken(a.activationPath), '7395'));
    // …y un QR de via 'gift' del mismo saldo, sin usar, ya no sirve (regalo guardado).
    const stray = await sys(async (tx) => {
      const { issueActivationToken } = await import('../../src/modules/wallets/wallet-activation-token');
      return issueActivationToken(tx, { walletId: h.walletId, venueId: A, issuedById: null, via: 'gift' });
    });
    expect(await pub(() => uses.view(stray.token))).toEqual({ state: 'used' });
    await expect(pub(() => uses.setPin(stray.token, '1593'))).rejects.toMatchObject({ response: { code: 'ACTIVATION_USED' } });
  });
});

describe('caducidad y datos personales', () => {
  it('sin guardar pasado su plazo: el enlace ya no vale, pero el panel lo lista como caducado (el saldo sigue)', async () => {
    const g = await paidGift(codeA, A, 10000);
    await sys((tx) => tx.$executeRaw`UPDATE wallet_gifts SET "createdAt" = now() - interval '91 days', "expiresAt" = now() - interval '1 day' WHERE "paymentId" = ${g.paymentId}::uuid`);
    expect((await pub(() => gifts.view(g.token)))?.state).toBe('expired');
    expect(await pub(() => gifts.claim(g.token))).toEqual({ state: 'expired' });
    const row = (await pub(() => settings.view(A))).gifts.find((x) => x.amountCents === 10000);
    expect(row?.state).toBe('expired');
    expect((await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: g.walletId } }))).balanceCents).toBe(10000);
  });

  it('el nombre y el mensaje se borran al caducar sin guardar y a los 30 días de guardarlo (no antes)', async () => {
    const recent = await paidGift(codeA, A, 2000);
    const claimedOld = await paidGift(codeA, A, 2000);
    await sys((tx) =>
      tx.$executeRaw`UPDATE wallet_gifts SET "claimedAt" = now() - (${GIFT_TEXT_KEEP_DAYS + 1} * interval '1 day') WHERE "paymentId" = ${claimedOld.paymentId}::uuid`,
    );
    const claimedNow = await paidGift(codeA, A, 2000);
    await sys((tx) => tx.$executeRaw`UPDATE wallet_gifts SET "claimedAt" = now() WHERE "paymentId" = ${claimedNow.paymentId}::uuid`);
    await pub(() => eraseGiftTexts(prisma));
    const texts = async (paymentId: string) => {
      const row = await giftOfPayment(paymentId);
      return [row.toName, row.message];
    };
    expect(await texts(recent.paymentId)).toEqual(['Lucía', 'Feliz cumple']);
    expect(await texts(claimedNow.paymentId)).toEqual(['Lucía', 'Feliz cumple']);
    expect(await texts(claimedOld.paymentId)).toEqual([null, null]);
    // El caducado de la prueba anterior, también.
    const expired = await sys((tx) => tx.walletGift.findFirstOrThrow({ where: { tenantId: A, expiresAt: { lt: new Date() } } }));
    expect([expired.toName, expired.message]).toEqual([null, null]);
  });
});

describe('RLS: el regalo es de su local', () => {
  it('con el local B en la sesión no se ve ni se toca ningún regalo de A (FORCE RLS, sin filtrar en la consulta)', async () => {
    await pub(() => settings.setGifts(owner(B), true));
    const gb = await paidGift(codeB, B, 2500);
    const countA = await sys((tx) => tx.walletGift.count({ where: { tenantId: A } }));
    expect(countA).toBeGreaterThan(0);
    const seenFromB = await inVenue(B, () =>
      prisma.withTenant(B, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ tenantId: string }>>`SELECT "tenantId"::text AS "tenantId" FROM wallet_gifts`;
        const touched = await tx.$executeRaw`UPDATE wallet_gifts SET "toName" = 'X' WHERE "tenantId" = ${A}::uuid`;
        return { tenants: [...new Set(rows.map((x) => x.tenantId))], touched };
      }),
    );
    expect(seenFromB.tenants).toEqual([B]);
    expect(seenFromB.touched).toBe(0);
    // Y B no puede crear uno a nombre de A.
    await expect(
      inVenue(B, () =>
        prisma.withTenant(B, (tx) =>
          tx.$executeRaw`INSERT INTO wallet_gifts ("tenantId", "walletId", "paymentId", token, "expiresAt") VALUES (${A}::uuid, ${gb.walletId}::uuid, ${gb.paymentId}::uuid, ${'Z'.repeat(32)}, now() + interval '1 day')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // El panel de B solo lista los suyos.
    const panelB = await inVenue(B, () => settings.view(B));
    expect(panelB.gifts).toHaveLength(1);
    expect(panelB.gifts[0]).toMatchObject({ amountCents: 2500, state: 'open' });
  });

  it('la base no deja un enlace raro ni un nombre o un mensaje largos', async () => {
    const g = await paidGift(codeA, A, 1500);
    for (const data of [{ token: 'corto' }, { toName: 'a'.repeat(41) }, { message: 'b'.repeat(121) }, { toName: '' }]) {
      await expect(sys((tx) => tx.walletGift.update({ where: { paymentId: g.paymentId }, data }))).rejects.toThrow();
    }
  });
});
