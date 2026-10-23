// Integración (Postgres real): informes por periodo (métricas, Z e IVA). Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { summarize } from '../../src/modules/reports/export-csv';
import { chicaShareCents } from '../../src/modules/reports/export-rows';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const period = new PeriodReportsService(prisma as never);
const reports = new ReportsService(prisma as never);

function sys<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't', acrossVenues: true });
    return prisma.asSystem(() => fn());
  });
}

const r = randomUUID().slice(0, 6);
const T = (iso: string) => new Date(iso);
const WINDOW = { from: T('2026-10-13T22:00:00Z'), to: T('2026-10-14T22:00:00Z') };
let A: string, B: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    await prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local A', slug: `a-${r}`, walletGroup: `g-${r}` } })).id;
      B = (await tx.venue.create({ data: { name: 'Local B', slug: `b-${r}`, walletGroup: `g-${r}` } })).id;
      const owner = (await tx.user.create({ data: { tenantId: A, email: `o-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      const lola = (await tx.user.create({ data: { tenantId: A, email: `lola-${r}@x.es`, displayName: 'Lola', passwordHash: 'x', role: 'OPERATOR' } })).id;
      const waiter = (await tx.user.create({ data: { tenantId: A, email: `w-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
      const ownerB = (await tx.user.create({ data: { tenantId: B, email: `ob-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      const term = (await tx.terminal.create({ data: { tenantId: A, externalId: `T-${r}`, label: 'T', zone: 'BARRA' } })).id;
      const termB = (await tx.terminal.create({ data: { tenantId: B, externalId: `TB-${r}`, label: 'TB' } })).id;
      const W = (await tx.clientWallet.create({ data: { tenantId: A, balanceCents: 2000, qrToken: `wq-${r}` } })).id;
      const W2 = (await tx.clientWallet.create({ data: { tenantId: A, balanceCents: 0, qrToken: `wq2-${r}`, status: 'REFUNDED' } })).id;
      let k = 0;
      const pay = (o: Record<string, unknown>) =>
        tx.payment.create({
          data: {
            tenantId: A, terminalId: term, idempotencyKey: `p-${r}-${k++}`, amountCents: 0, availableAmountCents: 0,
            qrToken: `qr-${r}-${k}`, qrExpiresAt: T('2026-10-15T00:00:00Z'), status: 'AUTHORIZED', provider: 'REDSYS',
            providerTxId: `O${r}${k}`, ...o,
          } as never,
        });
      // Servicio de Lola: 100 € + 5 € de propina; se le paga y luego se devuelve la mitad (deuda 47,50 €).
      const p1 = await pay({ amountCents: 10_000, tipCents: 500, availableAmountCents: 5250, status: 'PARTIALLY_REFUNDED',
        createdAt: T('2026-10-14T19:59:00Z'), authorizedAt: T('2026-10-14T20:00:00Z'), createdByUserId: lola, revenueCategory: 'CHICA_SERVICE', captureMethod: 'QR' });
      const po = await tx.operatorPayout.create({ data: { tenantId: A, operatorId: lola, totalCents: 9500, paidByUserId: owner, createdAt: T('2026-10-14T20:30:00Z') } });
      const e1 = await tx.operatorEarning.create({ data: { tenantId: A, operatorId: lola, paymentId: p1.id, paymentAmountCents: 10_000, commissionBps: 9000, commissionCents: 9000, tipCents: 500, payoutId: po.id } });
      const r1 = await tx.refund.create({ data: { tenantId: A, paymentId: p1.id, amountCents: 5250, requestedBy: owner, status: 'SUCCEEDED', registeredManually: true, bankRefundedAt: T('2026-10-14T21:00:00Z'), createdAt: T('2026-10-14T21:00:05Z') } });
      await tx.earningReversal.create({ data: { tenantId: A, earningId: e1.id, refundId: r1.id, reversedDeltaCents: 4750, afterPayout: true } });
      // Barra cobrada en el datáfono: 30 €.
      await pay({ amountCents: 3000, availableAmountCents: 3000, captureMethod: 'POS_EXTERNAL', provider: 'PAYTEF', revenueCategory: 'VENUE_BAR',
        createdAt: T('2026-10-14T21:29:00Z'), authorizedAt: T('2026-10-14T21:30:00Z'), createdByUserId: waiter });
      // Recarga de 200 € (W): gasta 60+10 con Lola y 30 en barra; uno de 20 anulado; 80 € en efectivo.
      await pay({ amountCents: 20_000, availableAmountCents: 20_000, walletId: W, captureMethod: 'WALLET_TOPUP', revenueCategory: 'EXTRA',
        createdAt: T('2026-10-14T18:59:00Z'), authorizedAt: T('2026-10-14T19:00:00Z') });
      const c1 = await tx.walletConsumption.create({ data: { tenantId: A, walletId: W, amountCents: 6000, tipCents: 1000, providedByUserId: lola, category: 'CHICA_SERVICE', createdAt: T('2026-10-14T19:30:00Z') } });
      await tx.operatorEarning.create({ data: { tenantId: A, operatorId: lola, consumptionId: c1.id, paymentAmountCents: 6000, commissionBps: 9000, commissionCents: 5400, tipCents: 1000 } });
      await tx.walletConsumption.create({ data: { tenantId: A, walletId: W, amountCents: 3000, providedByUserId: waiter, category: 'VENUE_BAR', createdAt: T('2026-10-14T19:40:00Z') } });
      const c3 = await tx.walletConsumption.create({ data: { tenantId: A, walletId: W, amountCents: 2000, providedByUserId: lola, category: 'CHICA_SERVICE', createdAt: T('2026-10-14T19:45:00Z'), reversedAt: T('2026-10-14T19:50:00Z'), reversedByUserId: owner } });
      await tx.operatorEarning.create({ data: { tenantId: A, operatorId: lola, consumptionId: c3.id, paymentAmountCents: 2000, commissionBps: 9000, commissionCents: 1800, reversedCents: 1800 } });
      await tx.walletPayout.create({ data: { tenantId: A, walletId: W, amountCents: 8000, method: 'CASH', paidByUserId: owner, createdAt: T('2026-10-14T21:45:00Z') } });
      // Recarga de 50 € (W2) devuelta entera a la tarjeta: devolución + wallet_payouts CARD.
      const p4 = await pay({ amountCents: 5000, availableAmountCents: 0, status: 'REFUNDED', walletId: W2, captureMethod: 'WALLET_TOPUP', revenueCategory: 'EXTRA',
        createdAt: T('2026-10-14T17:59:00Z'), authorizedAt: T('2026-10-14T18:00:00Z') });
      await tx.refund.create({ data: { tenantId: A, paymentId: p4.id, amountCents: 5000, requestedBy: owner, status: 'SUCCEEDED', registeredManually: true, bankRefundedAt: T('2026-10-14T21:50:00Z'), createdAt: T('2026-10-14T21:50:00Z'), reason: 'Devolución del saldo al cliente' } });
      await tx.walletPayout.create({ data: { tenantId: A, walletId: W2, amountCents: 5000, method: 'CARD', paidByUserId: owner, createdAt: T('2026-10-14T21:50:01Z') } });
      // Otro local del grupo: no cuenta en A (ni su consumo del saldo W ni su efectivo).
      await tx.payment.create({ data: { tenantId: B, terminalId: termB, idempotencyKey: `pb-${r}`, amountCents: 99_900, availableAmountCents: 99_900,
        qrToken: `qrb-${r}`, qrExpiresAt: T('2026-10-15T00:00:00Z'), status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `OB${r}`,
        createdAt: T('2026-10-14T20:00:00Z'), authorizedAt: T('2026-10-14T20:00:00Z') } });
      await tx.walletConsumption.create({ data: { tenantId: B, walletId: W, amountCents: 4000, providedByUserId: ownerB, category: 'VENUE_BAR', createdAt: T('2026-10-14T20:10:00Z') } });
      await tx.walletPayout.create({ data: { tenantId: B, walletId: W, amountCents: 1000, method: 'CASH', paidByUserId: ownerB, createdAt: T('2026-10-14T21:00:00Z') } });
      // Bordes del IVA: 23:30 del 31-mar (marzo) y 00:30 del 1-abr (abril) en Madrid.
      await pay({ amountCents: 2420, availableAmountCents: 2420, revenueCategory: 'VENUE_BAR', createdAt: T('2026-03-31T21:30:00Z'), authorizedAt: T('2026-03-31T21:30:00Z') });
      await pay({ amountCents: 1210, availableAmountCents: 1210, revenueCategory: 'VENUE_BAR', createdAt: T('2026-03-31T22:30:00Z'), authorizedAt: T('2026-03-31T22:30:00Z') });
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('informes del periodo contra Postgres', () => {
  it('totales: recarga 200, devuelve 80 en efectivo; la tarjeta ya es devolución; sin el local B', async () => {
    const t = await sys(() => period.totals(A, WINDOW));
    expect(t).toEqual({
      paymentCount: 4,
      grossCents: 38_000,
      tipCents: 500,
      refundCount: 2,
      refundedCents: 10_250,
      refundedTipCents: 250,
      walletCashPayoutCount: 1,
      walletCashPayoutCents: 8000,
      walletCashTopUpCount: 0,
      walletCashTopUpCents: 0,
      walletCardPayoutCount: 1,
      walletCardPayoutCents: 5000,
      // Las dos recargas con tarjeta (200 € y la de 50 € devuelta luego): ya en paymentCount y grossCents.
      walletCardTopUpCount: 2,
      walletCardTopUpCents: 25_000,
    });
  });

  it('Z del periodo: ventas por tipo con consumos, saldo, chicas con su deuda', async () => {
    const z = await sys(() => period.periodZ(A, WINDOW, WINDOW.to));
    expect(z.summary.netCents).toBe(20_250);
    expect(z.byRevenueCategory).toEqual([
      expect.objectContaining({ category: 'CHICA_SERVICE', count: 2, grossCents: 16_000, consumptionCents: 6000 }),
      expect.objectContaining({ category: 'VENUE_BAR', count: 2, grossCents: 6000, consumptionCents: 3000 }),
    ]);
    expect(z.wallet).toEqual({
      topUpCount: 2, topUpCents: 25_000, consumptionCount: 2, consumptionCents: 9000, consumptionTipCents: 1000,
      cashTopUpCount: 0, cashTopUpCents: 0,
      cashPayoutCount: 1, cashPayoutCents: 8000, cardPayoutCount: 1, cardPayoutCents: 5000,
    });
    expect(z.topOperators).toEqual([expect.objectContaining({ displayName: 'Lola', netCents: 4750 + 6400, earningCount: 2 })]);
    expect(z.payouts).toEqual({ count: 1, totalCents: 9500 });
    expect(z.byZone).toEqual([{ zone: 'BARRA', count: 4, grossCents: 38_000, tipCents: 500 }]);
    expect(z.byProvider.map((p) => p.provider)).toEqual(['REDSYS', 'PAYTEF']);
  });

  it('métricas: hoy vacío a las 01:30 de Madrid; la semana lo tiene todo', async () => {
    const m = await sys(() => period.metrics(A, T('2026-10-14T23:30:00Z')));
    expect(m.today.count).toBe(0);
    expect(m.week).toMatchObject({ count: 4, netCents: 20_250 });
    expect(m.statusBreakdown).toEqual({});
  });

  it('filas de la gestoría = totales del periodo; parte de la chica con su deuda', async () => {
    const [cobros, devoluciones, liquidaciones, consumos, pagosSaldo] = await sys(() =>
      Promise.all([
        reports.cobros(A, WINDOW),
        reports.devoluciones(A, WINDOW),
        reports.liquidaciones(A, WINDOW),
        reports.consumos(A, WINDOW),
        reports.pagosSaldo(A, WINDOW),
      ]),
    );
    const s = summarize(cobros, devoluciones, liquidaciones, consumos, pagosSaldo);
    const t = await sys(() => period.totals(A, WINDOW));
    expect([s.count, s.grossCents, s.tipsCents, s.refundsCents, s.walletCashPayoutsCents, s.walletCardPayoutsCents]).toEqual([
      t.paymentCount, t.grossCents, t.tipCents, t.refundedCents, t.walletCashPayoutCents, t.walletCardPayoutCents,
    ]);
    expect(s.netCents).toBe(20_250);
    const p1 = cobros.find((c) => c.amountCents === 10_000)!;
    expect(p1.reversedAfterPayoutCents).toBe(4750);
    expect(chicaShareCents(p1)).toBe(4750);
    expect(consumos.map((c) => [c.category, c.commissionCents])).toEqual([['CHICA_SERVICE', 5400], ['VENUE_BAR', null]]);
    expect(pagosSaldo.map((p) => p.method)).toEqual(['CASH', 'CARD']);
    // La parte de Lola es la misma en el resumen y en el Z del periodo.
    const z = await sys(() => period.periodZ(A, WINDOW, WINDOW.to));
    expect(s.chicaNetCents).toBe(z.earnings.totalNetCents);
  });

  it('IVA: meses de Madrid (00:30 del 1-abr es abril) y facturado sin propinas', async () => {
    const q1 = await sys(() => period.vat303(A, 'Q1-2026'));
    const q2 = await sys(() => period.vat303(A, 'Q2-2026'));
    const q4 = await sys(() => period.vat303(A, 'Q4-2026'));
    if ('exento' in q1 || 'exento' in q2 || 'exento' in q4) throw new Error('no es exento');
    expect(q1.byMonth.map((m) => m.grossCents)).toEqual([0, 0, 2420]);
    expect(q2.byMonth.map((m) => m.grossCents)).toEqual([1210, 0, 0]);
    expect(q4.byMonth[0]).toMatchObject({ month: '2026-10', facturadoCents: 20_000, baseImponibleCents: 16_529, cuotaIvaCents: 3471 });
    expect(q4.walletInfo).toMatchObject({ consumptionCount: 2, consumptionCents: 9000 });
  });
});
