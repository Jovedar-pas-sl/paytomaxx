// Integración (Postgres real): anular consumos del saldo y devoluciones a la vez. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletsService } from '../../src/modules/wallets/wallets.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';

const cls = new ClsService(new AsyncLocalStorage());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaService(cls as any);
const audit = { log: async () => undefined };
const wallets = new WalletsService(prisma as never, audit as never, {} as never);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let gatewayCalls = 0;
const gateways = {
  get: () => ({
    refund: async () => {
      gatewayCalls += 1;
      await sleep(300);
      return { status: 'SUCCEEDED', providerRefundId: `R-${gatewayCalls}` };
    },
  }),
};
const paymentsStub = { transition: async () => ({}), applyRefundToEarning: async () => undefined };
const metrics = { refundsCreated: { inc() {} }, earningReversalFailed: { inc() {} } };
const refunds = new RefundsService(
  prisma as never,
  cls as never,
  gateways as never,
  paymentsStub as never,
  {} as never,
  audit as never,
  metrics as never,
);

function asSystemCtx<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    return fn();
  });
}
function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
}

const r = randomUUID().slice(0, 6);
let A: string, chica: string, owner: string, term: string, wallet: string;

async function consumption(o: { amount: number; tip: number; paid: boolean }) {
  return asSystemCtx(() =>
    prisma.asSystem(async (tx) => {
      const c = await tx.walletConsumption.create({
        data: { tenantId: A, walletId: wallet, amountCents: o.amount, tipCents: o.tip, providedByUserId: chica, category: 'CHICA_SERVICE' },
      });
      let payoutId: string | null = null;
      if (o.paid) {
        payoutId = (
          await tx.operatorPayout.create({ data: { tenantId: A, operatorId: chica, totalCents: 1000, paidByUserId: owner } })
        ).id;
      }
      const e = await tx.operatorEarning.create({
        data: {
          tenantId: A,
          operatorId: chica,
          consumptionId: c.id,
          paymentAmountCents: o.amount,
          commissionBps: 5000,
          commissionCents: o.amount / 2,
          tipCents: o.tip,
          payoutId,
        },
      });
      return { consumptionId: c.id, earningId: e.id };
    }),
  );
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await asSystemCtx(() =>
    prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local M', slug: `m-${r}`, walletGroup: `gm-${r}` } })).id;
      owner = (await tx.user.create({ data: { tenantId: A, email: `own-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      chica = (await tx.user.create({ data: { tenantId: A, email: `op-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id;
      term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TM-${r}`, label: 'M' } })).id;
      wallet = (await tx.clientWallet.create({ data: { tenantId: A, balanceCents: 0, status: 'DEPLETED', qrToken: `wq-${r}` } })).id;
    }),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('anular un consumo del saldo (Postgres real)', () => {
  it('ya pagado a la chica → deuda para su siguiente pago; el saldo vuelve y la wallet se reactiva', async () => {
    const { consumptionId, earningId } = await consumption({ amount: 4000, tip: 500, paid: true });
    const res = await wallets.reverseConsumption({ tenantId: A, walletId: wallet, consumptionId, actorUserId: owner, reason: 'error' });
    expect(res).toEqual({ refundedCents: 4500, newBalanceCents: 4500 });

    const rows = await asSystemCtx(() =>
      prisma.asSystem((tx) => tx.$queryRaw<Array<{ consumptionId: string; refundId: string | null; reversedDeltaCents: number; afterPayout: boolean }>>`
      SELECT "consumptionId"::text AS "consumptionId", "refundId"::text AS "refundId", "reversedDeltaCents", "afterPayout" FROM earning_reversals WHERE "earningId" = ${earningId}::uuid`),
    );
    expect(rows).toEqual([{ consumptionId, refundId: null, reversedDeltaCents: 2500, afterPayout: true }]);

    const w = await asSystemCtx(() => prisma.asSystem((tx) => tx.clientWallet.findUnique({ where: { id: wallet } })));
    expect(w?.status).toBe('ACTIVE');
    // Ya pagado: el earning no se toca (la deuda va aparte).
    const e = await asSystemCtx(() => prisma.asSystem((tx) => tx.operatorEarning.findUnique({ where: { id: earningId } })));
    expect(e?.reversedCents).toBe(0);
  });

  it('dos anulaciones a la vez del mismo consumo → solo una devuelve el dinero', async () => {
    const { consumptionId, earningId } = await consumption({ amount: 2000, tip: 0, paid: false });
    const before = await asSystemCtx(() => prisma.asSystem((tx) => tx.clientWallet.findUnique({ where: { id: wallet } })));
    const go = () =>
      wallets.reverseConsumption({ tenantId: A, walletId: wallet, consumptionId, actorUserId: owner, reason: 'doble clic' });
    const out = await Promise.allSettled([go(), go(), go()]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(out.filter((o) => o.status === 'rejected').map((o) => (o as PromiseRejectedResult).reason.status)).toEqual([409, 409]);

    const after = await asSystemCtx(() => prisma.asSystem((tx) => tx.clientWallet.findUnique({ where: { id: wallet } })));
    expect(after!.balanceCents - before!.balanceCents).toBe(2000);
    const e = await asSystemCtx(() => prisma.asSystem((tx) => tx.operatorEarning.findUnique({ where: { id: earningId } })));
    expect(e?.reversedCents).toBe(1000);
  });

  it('un reverso sin consumo ni devolución de origen → lo rechaza el CHECK', async () => {
    await expect(
      asSystemCtx(() =>
        prisma.asSystem((tx) => tx.$executeRaw`INSERT INTO earning_reversals ("tenantId","earningId","reversedDeltaCents","afterPayout")
        SELECT "tenantId", id, 1, true FROM operator_earnings WHERE "tenantId" = ${A}::uuid LIMIT 1`),
      ),
    ).rejects.toThrow(/earning_reversals_source_check/);
  });
});

describe('dos devoluciones a la vez del mismo cobro (Postgres real)', () => {
  it('no pasan de lo cobrado: una sale, la otra se rechaza antes de llamar al banco', async () => {
    const pay = await asSystemCtx(() =>
      prisma.asSystem((tx) =>
        tx.payment.create({
          data: {
            tenantId: A,
            terminalId: term,
            idempotencyKey: `rf-${r}`,
            amountCents: 6000,
            availableAmountCents: 6000,
            qrToken: `qr-rf-${r}`,
            qrExpiresAt: new Date(Date.now() + 3600_000),
            status: 'AUTHORIZED',
            provider: 'REDSYS',
            providerTxId: `ORDRF${r}`,
          },
        }),
      ),
    );
    gatewayCalls = 0;
    const actor = { userId: owner, role: 'OWNER' as const, tenantId: A };
    const go = () => asTenant(A, () => refunds.refund({ paymentId: pay.id, amountCents: 6000, reason: 'x' } as never, actor));
    const out = await Promise.allSettled([go(), go()]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason.message)).toMatch(/Solo quedan 0/);
    expect(gatewayCalls).toBe(1);
  });
});
