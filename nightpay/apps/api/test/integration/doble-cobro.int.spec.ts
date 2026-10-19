// Integración (Postgres real): dos aprobaciones del banco del mismo cobro a la
// vez (el doble cobro se apunta con el candado del cobro) y venta anulada en el
// datáfono con el cobro aún pagado (Incidencias). np_app y FORCE RLS. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { InvalidTransitionError, isIdempotentTransition } from '../../src/modules/payments/payment.machine';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const metrics = {
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
const incidents = new IncidentsService(prisma as never, { log: async () => undefined } as never);

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

/** Cobro de Redsys esperando al banco con dos pedidos abiertos (el cliente reintentó en 3D Secure). */
async function twoOrders(): Promise<{ id: string; orders: [string, string] }> {
  n += 1;
  const orders: [string, string] = [`DA${r}${n}`, `DB${r}${n}`];
  const id = await sys(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        idempotencyKey: `dbl-${r}-${n}`,
        amountCents: 10_000,
        availableAmountCents: 10_000,
        qrToken: `dbl-${r}-${n}`,
        qrExpiresAt: new Date(Date.now() + 3600_000),
        status: 'AUTHORIZING',
        provider: 'REDSYS',
        providerTxId: orders[1],
        createdByUserId: chica,
        revenueCategory: 'CHICA_SERVICE',
      },
    });
    await tx.paymentAttempt.createMany({
      data: orders.map((providerTxId) => ({
        paymentId: p.id,
        tenantId: A,
        provider: 'REDSYS' as const,
        providerTxId,
        amountCents: 10_000,
        tipCents: 0,
      })),
    });
    return p.id;
  });
  return { id, orders };
}

const approve = (paymentId: string, order: string) =>
  inVenue(undefined, () => payments.transition(paymentId, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: order }));

async function stateOf(paymentId: string) {
  return sys(async (tx) => ({
    payment: await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, providerTxId: true } }),
    duplicates: await tx.paymentEvent.findMany({
      where: { paymentId, eventType: 'payment.duplicate_charge' },
      select: { payload: true },
    }),
    attempts: await tx.paymentAttempt.findMany({ where: { paymentId }, select: { providerTxId: true, status: true } }),
    earnings: await tx.operatorEarning.count({ where: { paymentId } }),
  }));
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Doble', slug: `dbl-${r}`, walletGroup: `gdbl-${r}` } })).id;
    chica = (
      await tx.user.create({ data: { tenantId: A, email: `op-dbl-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 9000 } })
    ).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TDBL-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('P1 doble cobro: dos aprobaciones del mismo cobro a la vez (Postgres real)', () => {
  it('los dos avisos a la vez: uno paga el cobro, el otro queda como doble cobro (una sola vez); varias rondas', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { id, orders } = await twoOrders();

      const out = await Promise.allSettled([approve(id, orders[0]), approve(id, orders[1])]);

      expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = out.find((o): o is PromiseRejectedResult => o.status === 'rejected')!;
      expect(rejected.reason).toBeInstanceOf(InvalidTransitionError);
      // Quien procesa el aviso lo da por procesado (no reintenta): ya está apuntado.
      expect(isIdempotentTransition(rejected.reason as InvalidTransitionError)).toBe(true);

      const s = await stateOf(id);
      const winner = s.payment.providerTxId!;
      const loser = orders.find((o) => o !== winner)!;
      expect(s.payment.status).toBe('AUTHORIZED');
      expect(orders).toContain(winner);
      expect(s.duplicates.map((d) => d.payload)).toEqual([{ order: loser, provider: 'REDSYS', chargedOrder: winner }]);
      expect(s.attempts.map((a) => a.status)).toEqual(['APPROVED', 'APPROVED']);
      expect(s.earnings).toBe(1);
    }
  });

  it('el aviso repetido, o el del pedido que pagó, no apunta nada más; también con el cobro ya devuelto', async () => {
    const { id, orders } = await twoOrders();
    await approve(id, orders[0]);
    await expect(approve(id, orders[1])).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(approve(id, orders[1])).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(approve(id, orders[0])).rejects.toBeInstanceOf(InvalidTransitionError);

    const s = await stateOf(id);
    expect(s.duplicates).toHaveLength(1);
    expect(s.payment).toEqual({ status: 'AUTHORIZED', providerTxId: orders[0] });

    // Devuelto entero: el segundo cargo sigue siendo dinero cobrado de más.
    const other = await twoOrders();
    await approve(other.id, other.orders[1]);
    await sys((tx) => tx.payment.update({ where: { id: other.id }, data: { status: 'REFUNDED', availableAmountCents: 0 } }));
    await expect(approve(other.id, other.orders[0])).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await stateOf(other.id)).duplicates).toHaveLength(1);
  });

  it('sale en Incidencias como doble cobro', async () => {
    const { id, orders } = await twoOrders();
    await approve(id, orders[1]);
    await expect(approve(id, orders[0])).rejects.toBeInstanceOf(InvalidTransitionError);

    const items = await inVenue(A, () => incidents.list(A));
    const dup = items.find((i) => i.kind === 'duplicate_charge' && i.paymentId === id);
    expect(dup).toMatchObject({ ackable: true, amountCents: 10_000 });
    expect(dup!.detail).toContain(orders[0]);
  });
});

describe('P4 venta anulada en el datáfono con el cobro pagado (Postgres real)', () => {
  it('sale en Incidencias mientras el cobro siga pagado con esa operación; devuelto, ya no', async () => {
    n += 1;
    const op = `OP${r}${n}`;
    const paid = await sys((tx) =>
      tx.payment.create({
        data: {
          tenantId: A,
          terminalId: term,
          idempotencyKey: `pos-${r}-${n}`,
          amountCents: 6_000,
          availableAmountCents: 6_000,
          qrToken: `pos-${r}-${n}`,
          qrExpiresAt: new Date(Date.now() + 3600_000),
          status: 'AUTHORIZED',
          authorizedAt: new Date(),
          captureMethod: 'POS_EXTERNAL',
          posTerminalId: term,
          posOperationNumber: op,
          createdByUserId: chica,
          revenueCategory: 'CHICA_SERVICE',
        },
      }),
    );
    const voided = (operationNumber: string) =>
      sys((tx) =>
        tx.paymentEvent.create({
          data: {
            paymentId: paid.id,
            tenantId: A,
            eventType: 'pos.voided',
            payload: { operationNumber, resultText: null, terminalId: term },
            traceId: randomUUID(),
          },
        }),
      );
    // Anular la operación del doble cobro (otra) no es esto: solo la que pagó el cobro.
    await voided(`${op}X`);
    const event = await voided(op);

    const open = (await inVenue(A, () => incidents.list(A))).filter((i) => i.kind === 'pos_voided_paid');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ refId: event.id.toString(), paymentId: paid.id, amountCents: 6_000, ackable: true });
    expect(open[0]!.detail).toContain(`Operación ${op}`);

    await sys((tx) => tx.payment.update({ where: { id: paid.id }, data: { status: 'REFUNDED', availableAmountCents: 0 } }));
    const after = (await inVenue(A, () => incidents.list(A))).filter((i) => i.kind === 'pos_voided_paid');
    expect(after).toHaveLength(0);
  });
});
