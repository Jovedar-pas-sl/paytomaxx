// Integración (Postgres real): «Recargar» desde la página del saldo (/w). La
// recarga es un cobro de recarga del local del saldo (la maquinaria de
// siempre), se suma una sola vez al pagarse, un segundo pedido aprobado es
// doble cobro, lo caducado no bloquea, y el saldo bloqueado, la pausa y las
// «Formas de cobro» se respetan. np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { InvalidTransitionError } from '../../src/modules/payments/payment.machine';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { WalletTopUpService } from '../../src/modules/wallets/wallet-topup.service';

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
const counters = new Map<string, number>();
const redis = {
  incr: async (k: string) => {
    counters.set(k, (counters.get(k) ?? 0) + 1);
    return counters.get(k)!;
  },
  expire: async () => 1,
};
const passkeys = { hasPasskey: vi.fn(async () => false), verify: vi.fn(), challenge: vi.fn(), assertOwner: vi.fn(async () => undefined) };
const SECRET = 'secreto-de-cookies-de-integracion-0123456789';
const topUps = new WalletTopUpService(
  prisma as never,
  passkeys as never,
  redis as never,
  { get: () => SECRET } as never,
  { get: () => payments } as never,
);
const period = new PeriodReportsService(prisma as never);

/** Como una petición pública (sin local ni persona en el contexto). */
const pub = <T>(fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => pub(() => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string;
let term: string;
let n = 0;

async function newWallet(o: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  n += 1;
  const token = `wrec-${r}-${n}`;
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: A, qrToken: token, shortCode: `R${r.slice(0, 3).toUpperCase()}${n}`.slice(0, 6), balanceCents: 2000, ...o } as never,
    });
    return w.id;
  });
  return { id, token };
}

const key = () => `k${randomUUID().replace(/-/g, '')}`.slice(0, 24);
const start = (token: string, k = key(), amountCents = 5000) =>
  pub(() => topUps.start(token, { amountCents, key: k, lang: 'es' }, 'api.test'));

async function paymentOf(payToken: string) {
  return sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: payToken } }));
}

/** El cliente fue al banco: el cobro espera el aviso con estos pedidos abiertos. */
async function atBank(paymentId: string, orders: string[]): Promise<void> {
  await pub(() => payments.transition(paymentId, { type: 'AUTHORIZING' }));
  await sys(async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { provider: 'REDSYS', providerTxId: orders[orders.length - 1] } });
    await tx.paymentAttempt.createMany({
      data: orders.map((providerTxId) => ({ paymentId, tenantId: A, provider: 'REDSYS' as const, providerTxId, amountCents: 5000, tipCents: 0 })),
    });
  });
}

const approve = (paymentId: string, order: string) =>
  pub(() => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));

const balanceOf = (walletId: string) =>
  sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCents: true, status: true } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Recarga', slug: `rec-${r}`, walletGroup: `grec-${r}` } })).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TREC-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«Recargar» desde /w (Postgres real)', () => {
  it('cobro de recarga de ESTE saldo en su local: sin propina, sin chica, sin saldo nuevo; se suma una vez al pagarse', async () => {
    const w = await newWallet();
    const walletsBefore = await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }));

    const out = await start(w.token);
    const p = await paymentOf(out.payToken);
    expect(p).toMatchObject({
      tenantId: A,
      terminalId: term,
      walletId: w.id,
      status: 'CREATED',
      amountCents: 5000,
      tipCents: 0,
      captureMethod: 'WALLET_TOPUP',
      revenueCategory: 'EXTRA',
      createdByUserId: null,
      operatorCommissionBps: null,
    });
    expect(out.payUrl).toBe(`/pay/${out.payToken}?lang=es`);
    expect(await sys((tx) => tx.clientWallet.count({ where: { tenantId: A } }))).toBe(walletsBefore);
    // La página de pago no ofrece propina en una recarga.
    await expect(pub(() => payments.getPayPage(out.payToken))).resolves.toMatchObject({ kind: 'choose', tipMaxCents: 0 });

    await atBank(p.id, [`RA${r}1`]);
    await approve(p.id, `RA${r}1`);
    expect(await balanceOf(w.id)).toEqual({ balanceCents: 7000, status: 'ACTIVE' });
    // El aviso repetido no suma otra vez.
    await expect(approve(p.id, `RA${r}1`)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await balanceOf(w.id)).balanceCents).toBe(7000);
    // Sin comisión de nadie: la recarga no es una venta.
    expect(await sys((tx) => tx.operatorEarning.count({ where: { paymentId: p.id } }))).toBe(0);
  });

  it('doble toque (la misma clave) → el mismo cobro', async () => {
    const w = await newWallet();
    const k = key();
    const [a, b] = await Promise.all([start(w.token, k), start(w.token, k)]);
    expect(a.payToken).toBe(b.payToken);
    expect(await sys((tx) => tx.payment.count({ where: { walletId: w.id } }))).toBe(1);
  });

  it('pagada dos veces (dos pedidos aprobados) → incidencia de doble cobro y el saldo se suma una sola vez', async () => {
    const w = await newWallet();
    const out = await start(w.token);
    const p = await paymentOf(out.payToken);
    const orders = [`RB${r}1`, `RB${r}2`];
    await atBank(p.id, orders);

    const res = await Promise.allSettled([approve(p.id, orders[0]!), approve(p.id, orders[1]!)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await balanceOf(w.id)).balanceCents).toBe(7000);
    const dup = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.duplicate_charge' } }));
    expect(dup).toHaveLength(1);
  });

  it('una recarga caducada o abandonada en el banco no impide empezar otra; la misma clave caducada → 409', async () => {
    const w = await newWallet();
    const k1 = key();
    const first = await start(w.token, k1);
    const p1 = await paymentOf(first.payToken);
    await pub(() => payments.transition(p1.id, { type: 'TIMEOUT' }));
    await expect(start(w.token, k1)).rejects.toThrow('ya no vale');

    // Otra se queda en el banco sin aviso (AUTHORIZING): tampoco bloquea.
    const second = await start(w.token);
    await atBank((await paymentOf(second.payToken)).id, [`RC${r}1`]);
    const third = await start(w.token);
    expect(third.payToken).not.toBe(second.payToken);
    expect(await sys((tx) => tx.payment.count({ where: { walletId: w.id } }))).toBe(3);
  });

  it('a cero (DEPLETED) se recarga y vuelve a estar activo', async () => {
    const w = await newWallet({ balanceCents: 0, status: 'DEPLETED' });
    const out = await start(w.token, key(), 2000);
    const p = await paymentOf(out.payToken);
    await atBank(p.id, [`RD${r}1`]);
    await approve(p.id, `RD${r}1`);
    expect(await balanceOf(w.id)).toEqual({ balanceCents: 2000, status: 'ACTIVE' });
  });

  it('tras pagar: /pay/result y /pay dan la vuelta al saldo (con la huella de la cookie de vuelta) y /w su «Pagado»', async () => {
    const w = await newWallet();
    const out = await start(w.token);
    const p = await paymentOf(out.payToken);
    await expect(pub(() => topUps.paidProof(w.token, out.payToken))).resolves.toBeNull();
    await atBank(p.id, [`RE${r}1`]);
    await approve(p.id, `RE${r}1`);

    const claimHash = createHash('sha256').update(out.claim).digest('hex');
    await expect(pub(() => payments.getResultView(`RE${r}1`))).resolves.toMatchObject({
      status: 'AUTHORIZED',
      walletToken: null,
      walletCode: null,
      walletReturnToken: w.token,
      walletClaimHash: claimHash,
    });
    await expect(pub(() => payments.getPayPage(out.payToken))).resolves.toMatchObject({
      kind: 'paid',
      walletReturnToken: w.token,
      walletClaimHash: claimHash,
    });
    await expect(pub(() => topUps.paidProof(w.token, out.payToken))).resolves.toMatchObject({ amountCents: 5000, payToken: out.payToken });
    // El «Pagado» de una recarga de otro saldo no sale aquí.
    const other = await newWallet();
    await expect(pub(() => topUps.paidProof(other.token, out.payToken))).resolves.toBeNull();
  });

  it('saldo bloqueado, local en pausa y «Formas de cobro» apagadas → no se crea nada', async () => {
    const blocked = await newWallet({ blockedAt: new Date(), blockedReason: 'prueba' });
    await expect(start(blocked.token)).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'blocked' }) });

    const w = await newWallet();
    await sys((tx) => tx.venue.update({ where: { id: A }, data: { pausedAt: new Date(), pausedReason: 'prueba' } }));
    try {
      const err = await start(w.token).catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(423);
      await expect(pub(() => topUps.options(w.token))).resolves.toMatchObject({ allowed: false, block: 'paused' });
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: A }, data: { pausedAt: null, pausedReason: null } }));
    }
    for (const paymentMethods of [{ card: false }, { wallet: false }]) {
      await sys((tx) => tx.venue.update({ where: { id: A }, data: { paymentMethods } }));
      try {
        await expect(start(w.token)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PAYMENT_METHOD_DISABLED' }) });
      } finally {
        await sys((tx) => tx.venue.update({ where: { id: A }, data: { paymentMethods: {} } }));
      }
    }
    expect(await sys((tx) => tx.payment.count({ where: { walletId: { in: [blocked.id, w.id] } } }))).toBe(0);
    await expect(pub(() => topUps.options(w.token))).resolves.toMatchObject({ allowed: true });
  });

  it('informes: cuenta como recarga (dinero que entra), no como venta, igual que las del personal', async () => {
    const from = new Date(Date.now() - 3600_000);
    const z = await cls.run(async () => {
      cls.set('ctx', { traceId: 't', acrossVenues: true });
      return prisma.asSystem(() => period.periodZ(A, { from, to: new Date(Date.now() + 60_000) }));
    });
    const paidTopUps = await sys((tx) =>
      tx.payment.aggregate({ where: { tenantId: A, walletId: { not: null }, status: 'AUTHORIZED' }, _sum: { amountCents: true }, _count: true }),
    );
    expect(z.wallet.topUpCount).toBe(paidTopUps._count);
    expect(z.wallet.topUpCents).toBe(paidTopUps._sum.amountCents);
    expect(z.byRevenueCategory).toEqual([]);
  });
});

describe('«Recargar» desde /w con la comisión del servicio (Postgres real, M-3)', () => {
  let B: string;
  beforeAll(async () => {
    await sys(async (tx) => {
      // Un % con medios céntimos (10,5 %) para que se note cualquier redondeo distinto.
      B = (
        await tx.venue.create({
          data: { name: 'Sala Comisión', slug: `recf-${r}`, walletGroup: `grecf-${r}`, serviceFeeEnabled: true, serviceFeeBps: 1000, topUpServiceFeeBps: 1050 },
        })
      ).id;
      await tx.terminal.create({ data: { tenantId: B, externalId: `TRECF-${r}`, label: 'Barra', zone: 'BARRA' } });
      await tx.gatewayCredential.create({
        data: { tenantId: B, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
      });
    });
  });

  it('la comisión que enseña la página (y el total del botón) es la que cobra el servidor: 10, 33, 57, 299 y 300 €', async () => {
    for (const euros of [10, 33, 57, 299, 300]) {
      const w = await newWallet({ tenantId: B, walletGroup: `grecf-${r}` });
      const opts = await pub(() => topUps.options(w.token));
      const cents = euros * 100;
      const fee = opts.feesCents![(cents - opts.minCents) / 100]!;
      const out = await start(w.token, key(), cents);
      const p = await paymentOf(out.payToken);
      // Lo que crea el servidor: el saldo y su comisión, la misma que dijo la página.
      expect({ euros, amountCents: p.amountCents, serviceFeeCents: p.serviceFeeCents }).toEqual({ euros, amountCents: cents, serviceFeeCents: fee });
      // Y la página de pago pide ese mismo total.
      await expect(pub(() => payments.getPayPage(out.payToken))).resolves.toMatchObject({ kind: 'choose', amountCents: cents, serviceFeeCents: fee, topUp: true });
    }
    // 33 € al 10,5 % = 3,465 € → 3,47 € (la mitad, hacia arriba): el botón dice «Pagar 36,47 €».
    const w = await newWallet({ tenantId: B, walletGroup: `grecf-${r}` });
    expect((await pub(() => topUps.options(w.token))).feesCents![23]).toBe(347);
  });
});
