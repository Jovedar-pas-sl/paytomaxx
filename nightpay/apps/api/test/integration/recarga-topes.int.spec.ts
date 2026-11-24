// Integración (Postgres real): topes de la recarga desde /w y desde la ficha
// (24 h y a medias, contados en la base, también con varias a la vez), la
// recarga que «creó el saldo» cuando el saldo se abrió en efectivo, y el saldo
// bloqueado por el super-admin (no se recarga con
// tarjeta, no se busca por código y, si se bloquea a medias, no se suma).
// np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  duplicateCharges: { inc: vi.fn() },
};
const realtime = { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() };
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  realtime as never,
  metrics as never,
  {} as never,
  {} as never,
);
// Sin límite por saldo en Redis aquí (cada prueba su saldo): lo que se mira es el tope de la base.
const redis = { incr: async () => 1, expire: async () => 1 };
const passkeys = { hasPasskey: vi.fn(async () => false), verify: vi.fn(), challenge: vi.fn(), assertOwner: vi.fn(async () => undefined) };
const SECRET = 'secreto-de-cookies-de-integracion-0123456789';
const topUps = new WalletTopUpService(
  prisma as never,
  passkeys as never,
  redis as never,
  { get: () => SECRET } as never,
  { get: () => payments } as never,
);
const charges = new WalletChargesService(prisma as never, { log: vi.fn() } as never, {} as never, {} as never);

const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string;
let TERM: string;
let OWNER: string;
let n = 0;
let orders = 0;

async function newWallet(o: Record<string, unknown> = {}): Promise<{ id: string; token: string; code: string }> {
  n += 1;
  const token = `wtop-${r}-${n}`;
  const code = `T${r.slice(0, 3).toUpperCase()}${n}`.slice(0, 6).padEnd(6, 'X');
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: A, qrToken: token, shortCode: code, balanceCents: 0, ...o } as never,
    });
    return w.id;
  });
  return { id, token, code };
}

const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
const start = (token: string, amountCents: number, k = key()) =>
  pub(() => topUps.start(token, { amountCents, key: k, lang: 'es' }, 'api.test'));

const paymentOf = (payToken: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: payToken } }));

/** El cliente paga en el banco y llega el aviso: AUTHORIZED. */
async function pay(paymentId: string): Promise<void> {
  orders += 1;
  const order = `RT${r}${orders}`;
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { provider: 'REDSYS', providerTxId: order } });
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { amountCents: true } });
    await tx.paymentAttempt.create({
      data: { paymentId, tenantId: A, provider: 'REDSYS', providerTxId: order, amountCents: p.amountCents, tipCents: 0, claimHash: 'huella' },
    });
  });
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));
}

/** Se queda en el banco sin respuesta (AUTHORIZING). */
async function atBank(paymentId: string): Promise<void> {
  orders += 1;
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZING' }));
  await sys((tx) => tx.payment.update({ where: { id: paymentId }, data: { provider: 'REDSYS', providerTxId: `RT${r}${orders}` } }));
}

const balanceOf = (walletId: string) =>
  sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCents: true } }));

/** Recarga que cobra el personal desde su app (no desde /w). */
const staffTopUp = (dto: Record<string, unknown>) =>
  pub(() =>
    payments.create(A, `staff-${randomUUID()}`, { amountCents: 2000, currency: 'EUR', terminalExternalId: `TTOP-${r}`, ...dto } as never, {
      userId: OWNER,
      role: 'OWNER',
    }),
  );

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Topes', slug: `top-${r}`, walletGroup: `gtop-${r}` } })).id;
    TERM = (await tx.terminal.create({ data: { tenantId: A, externalId: `TTOP-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    OWNER = (await tx.user.create({ data: { tenantId: A, email: `own-top-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Recargar» desde /w: tope de 24 h por saldo, contado en la base', () => {
  it('600 € en 24 h: 300 + 300 pagadas → una más de 10 € da 409 y no se crea', async () => {
    const w = await newWallet();
    for (let i = 0; i < 2; i += 1) await pay((await paymentOf((await start(w.token, 30_000)).payToken)).id);
    expect((await balanceOf(w.id)).balanceCents).toBe(60_000);
    await expect(start(w.token, 1_000)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'WALLET_TOPUP_DAILY_LIMIT' }),
    });
    expect(await sys((tx) => tx.payment.count({ where: { walletId: w.id } }))).toBe(2);
  });

  it('las recargas del personal no cuentan; lo caducado tampoco', async () => {
    const w = await newWallet();
    await pay((await staffTopUp({ wallet: { walletId: w.id }, amountCents: 50_000 })).id);
    const first = await paymentOf((await start(w.token, 30_000)).payToken);
    await pub(() => payments.transition(first.id, { type: 'TIMEOUT' }));
    // 50 € del personal + 300 € caducados no cuentan: caben 300 + 300.
    await pay((await paymentOf((await start(w.token, 30_000)).payToken)).id);
    await expect(start(w.token, 30_000)).resolves.toMatchObject({ payToken: expect.any(String) });
  });

  it('3 a medias o sin confirmar (en el banco o con el QR vigente) → la 4ª da 409', async () => {
    const w = await newWallet();
    await atBank((await paymentOf((await start(w.token, 1_000)).payToken)).id);
    await atBank((await paymentOf((await start(w.token, 1_000)).payToken)).id);
    await start(w.token, 1_000);
    await expect(start(w.token, 1_000)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WALLET_TOPUP_PENDING_LIMIT' }),
    });
  });

  it('dos «Recargar» a la vez que no caben juntas: queda una sola viva', async () => {
    const w = await newWallet();
    await pay((await paymentOf((await start(w.token, 30_000)).payToken)).id);
    const out = await Promise.allSettled([start(w.token, 30_000), start(w.token, 30_000)]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ response: expect.objectContaining({ code: 'WALLET_TOPUP_DAILY_LIMIT' }) });
    const live = await sys((tx) => tx.payment.count({ where: { walletId: w.id, status: 'CREATED' } }));
    expect(live).toBe(1);
  });

  it('la misma clave repetida (doble toque) no choca con el tope que ella misma llena', async () => {
    const w = await newWallet();
    await pay((await paymentOf((await start(w.token, 30_000)).payToken)).id);
    const k = key();
    const a = await start(w.token, 30_000, k);
    await expect(start(w.token, 30_000, k)).resolves.toMatchObject({ payToken: a.payToken });
  });
});

describe('«Recargar esta ficha» (B7): tope de 200 € en 24 h, también con peticiones a la vez', () => {
  it('4 de 200 € a la vez (un programa): queda una sola viva, no 800 €', async () => {
    const w = await newWallet();
    const fromFicha = () => pub(() => topUps.startFromFicha(w.token, `ficha-${w.id}`, { amountCents: 20_000, key: key(), lang: 'es' }));
    const out = await Promise.allSettled([fromFicha(), fromFicha(), fromFicha(), fromFicha()]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of out.filter((o): o is PromiseRejectedResult => o.status === 'rejected')) {
      expect(o.reason).toMatchObject({ status: 409, response: expect.objectContaining({ code: expect.stringMatching(/^WALLET_TOPUP_(DAILY|PENDING)_LIMIT$/) }) });
    }
    const live = await sys((tx) => tx.payment.findMany({ where: { walletId: w.id, status: 'CREATED' }, select: { amountCents: true } }));
    expect(live).toEqual([{ amountCents: 20_000 }]);
  });
});

describe('la recarga que «creó el saldo» cuenta también el efectivo', () => {
  it('saldo abierto en efectivo: quien paga la primera recarga con tarjeta no se lleva el saldo', async () => {
    const w = await newWallet({ balanceCents: 3_000 });
    await sys((tx) =>
      tx.walletCashTopUp.create({ data: { tenantId: A, walletId: w.id, amountCents: 3_000, terminalId: TERM, idempotencyKey: `cash-${w.id}` } }),
    );
    const card = await staffTopUp({ wallet: { walletId: w.id } });
    await pay(card.id);
    await expect(pub(() => payments.getPayPage(card.qrToken))).resolves.toMatchObject({
      kind: 'paid',
      walletToken: null,
      walletCode: null,
      walletClaimHash: null,
      walletHasFaceId: false,
    });
    const order = (await sys((tx) => tx.paymentAttempt.findFirstOrThrow({ where: { paymentId: card.id } }))).providerTxId;
    await expect(pub(() => payments.getResultView(order))).resolves.toMatchObject({ walletToken: null, walletCode: null });
  });

  it('saldo creado con la recarga con tarjeta: esa sí da el enlace (al navegador que pagó)', async () => {
    const created = await staffTopUp({ wallet: { create: true } });
    await pay(created.id);
    const page = await pub(() => payments.getPayPage(created.qrToken));
    expect(page).toMatchObject({ kind: 'paid', walletToken: expect.any(String), walletClaimHash: 'huella' });
  });
});

describe('saldo bloqueado por el super-admin', () => {
  it('no se recarga con tarjeta (409 WALLET_BLOCKED) ni se encuentra por código', async () => {
    const w = await newWallet({ balanceCents: 5_000, blockedAt: new Date(), blockedReason: 'prueba' });
    await expect(staffTopUp({ wallet: { walletId: w.id } })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'WALLET_BLOCKED' }),
    });
    await expect(pub(() => charges.lookup(A, w.code))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WALLET_BLOCKED' }),
    });
    expect(await sys((tx) => tx.payment.count({ where: { walletId: w.id } }))).toBe(0);
  });

  it('bloqueado con la recarga a medias: al pagarse no se suma y sale como incidencia', async () => {
    const w = await newWallet({ balanceCents: 5_000 });
    const p = await staffTopUp({ wallet: { walletId: w.id } });
    await sys((tx) => tx.clientWallet.update({ where: { id: w.id }, data: { blockedAt: new Date(), blockedReason: 'prueba' } }));
    await pay(p.id);
    expect((await balanceOf(w.id)).balanceCents).toBe(5_000);
    const audit = await sys((tx) => tx.auditEvent.findFirst({ where: { targetId: p.id, action: 'wallet.credit_skipped_critical' } }));
    expect(audit?.payload).toMatchObject({ cause: 'blocked', amountCents: 2_000 });
  });
});
