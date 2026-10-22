// Integración (Postgres real): la reserva de las devoluciones por la pasarela con
// varias peticiones a la vez, con el FSM de verdad (PaymentsService.transition)
// descontando del cobro. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { BadGatewayException, ConflictException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { RefundReversalSweepService } from '../../src/modules/refunds/refund-reversal-sweep.service';
import { MetricsService } from '../../src/modules/metrics/metrics.service';

const cls = new ClsService(new AsyncLocalStorage());

const prisma = new PrismaService(cls as never);
const audit = { log: async () => undefined };
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  refundsCreated: { inc: vi.fn() },
  earningReversalFailed: { inc: vi.fn() },
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

type BankAnswer = 'SUCCEEDED' | 'FAILED' | 'PENDING';
/** Banco de mentira: tarda (para que las peticiones se solapen) y contesta lo que diga `answer`. */
const bank = { calls: 0, answer: 'SUCCEEDED' as BankAnswer, delayMs: 250 };
const gateways = {
  get: () => ({
    refund: async () => {
      bank.calls += 1;
      const n = bank.calls;
      await new Promise((r) => setTimeout(r, bank.delayMs));
      return { status: bank.answer, providerRefundId: bank.answer === 'PENDING' ? null : `RDV-${n}` };
    },
  }),
};
const refunds = new RefundsService(
  prisma as never,
  cls as never,
  gateways as never,
  payments as never,
  {} as never,
  audit as never,
  metrics as never,
);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string;
let chica: string;
let term: string;
let n = 0;

/**
 * Un dueño nuevo por prueba: el 2FA se pide por lo devuelto acumulado por
 * persona (100 € en 24 h) y aquí no se prueba eso.
 */
async function newOwner(): Promise<string> {
  n += 1;
  return sys(async (tx) => (await tx.user.create({ data: { tenantId: A, email: `own${n}-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id);
}

/** Cobro de Redsys ya pagado (de la chica, con su comisión apuntada si se pide). */
async function paidPayment(amountCents: number, commissionCents?: number): Promise<string> {
  n += 1;
  return sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        idempotencyKey: `dc-${r}-${n}`,
        amountCents,
        availableAmountCents: amountCents,
        qrToken: `dc-${r}-${n}`,
        qrExpiresAt: new Date('2030-01-01T00:00:00Z'),
        status: 'AUTHORIZED',
        provider: 'REDSYS',
        providerTxId: `DC${r}${n}`,
        createdByUserId: chica,
        revenueCategory: 'CHICA_SERVICE',
      },
    });
    if (commissionCents !== undefined) {
      await tx.operatorEarning.create({
        data: {
          tenantId: A,
          operatorId: chica,
          paymentId: p.id,
          paymentAmountCents: amountCents,
          commissionBps: 9000,
          commissionCents,
          tipCents: 0,
        },
      });
    }
    return p.id;
  });
}

function refundAs(owner: string, paymentId: string, amountCents: number, idempotencyKey?: string) {
  const actor = { userId: owner, role: 'OWNER' as const, tenantId: A };
  return inVenue(A, () => refunds.refund({ paymentId, amountCents, reason: 'cliente insatisfecho', idempotencyKey }, actor));
}

async function stateOf(paymentId: string) {
  return sys(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, availableAmountCents: true } });
    const rows = await tx.refund.findMany({ where: { paymentId }, select: { status: true, amountCents: true } });
    const sum = (s: string) => rows.filter((x) => x.status === s).reduce((t, x) => t + x.amountCents, 0);
    return {
      status: p.status,
      available: p.availableAmountCents,
      succeededCents: sum('SUCCEEDED'),
      pendingCents: sum('PENDING'),
      failedCount: rows.filter((x) => x.status === 'FAILED').length,
    };
  });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Bambú (Madrid)', slug: `dc-${r}`, walletGroup: `gdc-${r}` } })).id;
    chica = (
      await tx.user.create({ data: { tenantId: A, email: `lola-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000 } })
    ).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TDC-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('devoluciones a la vez del mismo cobro (Postgres real)', () => {
  it('la misma clave dos veces a la vez: una reserva, una llamada al banco; el reintento da la misma', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(5000);
    const key = randomUUID();
    bank.calls = 0;
    bank.answer = 'SUCCEEDED';
    const results = await Promise.allSettled([refundAs(owner, pay, 5000, key), refundAs(owner, pay, 5000, key)]);
    const done = results.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof refundAs>>> => x.status === 'fulfilled');
    const waiting = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(done.length).toBeGreaterThanOrEqual(1);
    // La otra o esperó al candado y vio la reserva en curso, o llegó cuando ya estaba hecha.
    for (const w of waiting) expect(w.reason).toMatchObject({ response: expect.objectContaining({ code: 'REFUND_IN_PROGRESS' }) });
    const first = done.find((d) => !('replayed' in d.value))!.value;
    expect(bank.calls).toBe(1);
    // Respuesta perdida: el reintento con la misma clave devuelve la misma, sin ir al banco.
    await expect(refundAs(owner, pay, 5000, key)).resolves.toEqual({ ...first, replayed: true });
    expect(await sys((tx) => tx.refund.count({ where: { paymentId: pay } }))).toBe(1);
    expect(await stateOf(pay)).toMatchObject({ status: 'REFUNDED', available: 0 });
    expect(bank.calls).toBe(1);
  });

  it('con la misma clave, otro importe, otra persona u otro cobro: 409 y no va al banco', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(5000);
    const key = randomUUID();
    bank.calls = 0;
    bank.answer = 'SUCCEEDED';
    await refundAs(owner, pay, 1000, key);
    const [otherOwner, otherPay] = [await newOwner(), await paidPayment(5000)];
    for (const call of [() => refundAs(owner, pay, 2000, key), () => refundAs(otherOwner, pay, 1000, key), () => refundAs(owner, otherPay, 1000, key)]) {
      await expect(call()).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REFUND_KEY_REUSED' }) });
    }
    expect(bank.calls).toBe(1);
    expect(await stateOf(pay)).toMatchObject({ available: 4000 });
    expect(await stateOf(otherPay)).toMatchObject({ available: 5000 });
  });

  it('dos devoluciones parciales a propósito (claves distintas): salen las dos', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(5000);
    bank.calls = 0;
    bank.answer = 'SUCCEEDED';
    await refundAs(owner, pay, 1000, randomUUID());
    await refundAs(owner, pay, 1000, randomUUID());
    expect(bank.calls).toBe(2);
    expect(await stateOf(pay)).toMatchObject({ status: 'PARTIALLY_REFUNDED', available: 3000 });
  });

  it('sin confirmar en el banco: el reintento da el mismo 502 y la misma reserva, sin otra llamada', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(3000);
    const key = randomUUID();
    bank.calls = 0;
    bank.answer = 'PENDING';
    const first = await refundAs(owner, pay, 3000, key).catch((e: { getStatus(): number; getResponse(): unknown }) => e);
    const replay = await refundAs(owner, pay, 3000, key).catch((e: { getStatus(): number; getResponse(): unknown }) => e);
    expect(first.getStatus()).toBe(502);
    expect(replay.getStatus()).toBe(502);
    expect(replay.getResponse()).toEqual(first.getResponse());
    expect(bank.calls).toBe(1);
    expect(await stateOf(pay)).toMatchObject({ pendingCents: 3000, available: 3000 });
  });

  it('cinco de 15 € sobre un cobro de 60 €: salen cuatro, la quinta no llega al banco', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(6000);
    bank.calls = 0;
    bank.answer = 'SUCCEEDED';

    const out = await Promise.allSettled(Array.from({ length: 5 }, () => refundAs(owner, pay, 1500)));

    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(4);
    const rejected = out.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);
    expect(bank.calls).toBe(4);
    expect(await stateOf(pay)).toEqual({ status: 'REFUNDED', available: 0, succeededCents: 6000, pendingCents: 0, failedCount: 0 });
  });

  it('dos personas a la vez, 40 € cada una sobre 60 €: el candado es el del cobro, no el de la persona', async () => {
    const [ana, bea] = [await newOwner(), await newOwner()];
    const pay = await paidPayment(6000);
    bank.calls = 0;
    bank.answer = 'SUCCEEDED';

    const out = await Promise.allSettled([refundAs(ana, pay, 4000), refundAs(bea, pay, 4000)]);

    expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((out.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(bank.calls).toBe(1);
    expect(await stateOf(pay)).toEqual({
      status: 'PARTIALLY_REFUNDED',
      available: 2000,
      succeededCents: 4000,
      pendingCents: 0,
      failedCount: 0,
    });
  });

  it('a la vez y con redondeos: la chica pierde exactamente su comisión entera, sin céntimos de más ni de menos', async () => {
    const owner = await newOwner();
    // 70,00 € con 63,00 € de comisión (90 %); 23,33 + 23,33 + 23,34 = 70,00 €.
    const pay = await paidPayment(7000, 6300);
    bank.calls = 0;
    bank.answer = 'SUCCEEDED';

    const out = await Promise.allSettled([refundAs(owner, pay, 2333), refundAs(owner, pay, 2333), refundAs(owner, pay, 2334)]);

    expect(out.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(await stateOf(pay)).toMatchObject({ status: 'REFUNDED', available: 0, succeededCents: 7000 });
    const earning = await sys((tx) =>
      tx.operatorEarning.findFirstOrThrow({ where: { paymentId: pay }, select: { commissionCents: true, reversedCents: true } }),
    );
    expect(earning).toEqual({ commissionCents: 6300, reversedCents: 6300 });
    const reversals = await sys((tx) => tx.earningReversal.count({ where: { earning: { paymentId: pay } } }));
    expect(reversals).toBe(3);
  });
});

describe('la reserva cuando el banco no dice que sí (Postgres real)', () => {
  it('el banco la rechaza: se libera la reserva y el dinero se puede devolver después', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(5000);
    bank.calls = 0;
    bank.answer = 'FAILED';

    await expect(refundAs(owner, pay, 5000)).rejects.toBeInstanceOf(ConflictException);
    expect(await stateOf(pay)).toEqual({ status: 'AUTHORIZED', available: 5000, succeededCents: 0, pendingCents: 0, failedCount: 1 });

    bank.answer = 'SUCCEEDED';
    await expect(refundAs(owner, pay, 5000)).resolves.toMatchObject({ status: 'SUCCEEDED', amountCents: 5000 });
    expect(await stateOf(pay)).toMatchObject({ status: 'REFUNDED', available: 0, succeededCents: 5000 });
  });

  it('el banco no confirma: queda pendiente y sigue reservada, así que no se puede devolver dos veces', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(5000);
    bank.calls = 0;
    bank.answer = 'PENDING';

    const unknown = await refundAs(owner, pay, 3000).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(BadGatewayException);
    expect((unknown as BadGatewayException).getResponse()).toMatchObject({ code: 'REFUND_OUTCOME_UNKNOWN' });

    // Lo cobrado aún no baja (no consta hecha), pero lo reservado no se puede volver a pedir.
    expect(await stateOf(pay)).toEqual({ status: 'AUTHORIZED', available: 5000, succeededCents: 0, pendingCents: 3000, failedCount: 0 });
    bank.answer = 'SUCCEEDED';
    await expect(refundAs(owner, pay, 5000)).rejects.toBeInstanceOf(ConflictException);
    await expect(refundAs(owner, pay, 2000)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(bank.calls).toBe(2);
    expect(await stateOf(pay)).toEqual({
      status: 'PARTIALLY_REFUNDED',
      available: 3000,
      succeededCents: 2000,
      pendingCents: 3000,
      failedCount: 0,
    });
  });
});

describe('sweep persistente (Postgres real)', () => {
  it('100 fallos antiguos dejan avanzar la fila 101 tras reinicio y siguen visibles en backlog/antigüedad', async () => {
    const owner = await newOwner();
    const pay = await paidPayment(1000, 900);
    const now = new Date('2001-01-02T00:00:00Z');
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: randomUUID(), tenantId: A, paymentId: pay, amountCents: 1, status: 'SUCCEEDED' as const, requestedBy: owner, createdAt: new Date(new Date('2001-01-01T00:00:00Z').getTime() + i * 1000) }));
    await sys((tx) => tx.refund.createMany({ data: rows }));
    const ids = rows.map((r) => r.id);
    const last = rows[100]!;
    const observations = new MetricsService();
    const retryPayments = { applyRefundToEarning: vi.fn(async (p: string, id: string, amount: number) => {
      if (id !== last.id) throw new Error('persistent failure');
      await payments.applyRefundToEarning(p, id, amount);
    }) };
    const sweep = new RefundReversalSweepService(prisma, retryPayments as never, observations);
    try {
      expect(await sweep.sweep(now)).toEqual({ checked: 100, applied: 0, failed: 100 });
      const restarted = new RefundReversalSweepService(prisma, retryPayments as never, observations);
      expect(await restarted.sweep(new Date(now.getTime() + 10 * 60_000))).toEqual({ checked: 1, applied: 1, failed: 0 });
      expect(retryPayments.applyRefundToEarning).toHaveBeenLastCalledWith(pay, last.id, 1);
      const deferred = await sys((tx) => tx.refund.findMany({ where: { id: { in: ids }, earningReversalRetryAt: { not: null } } }));
      expect(deferred).toHaveLength(100);
      expect(deferred.every((r) => r.createdAt < now && r.earningReversalRetryAt! > now)).toBe(true);
      sweep.onModuleInit();
      await observations.render();
      const backlog = await observations.earningReversalPending.get();
      const age = await observations.earningReversalOldestAge.get();
      expect(backlog.values[0]!.value).toBeGreaterThanOrEqual(100);
      expect(age.values[0]!.value).toBeGreaterThan(100_000_000);
    } finally {
      sweep.onModuleDestroy();
      await sys(async (tx) => {
        await tx.earningReversal.deleteMany({ where: { refundId: { in: ids } } });
        await tx.refund.deleteMany({ where: { id: { in: ids } } });
        await tx.operatorEarning.deleteMany({ where: { paymentId: pay } });
        await tx.payment.delete({ where: { id: pay } });
      });
    }
  });
});
