// Integración (Postgres real): cierre de noche y Z con lo apuntado tarde. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import type { NightZ } from '../../src/modules/nights/night-rules';

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const reports = new ReportsService(prisma as never);
// El cierre automático solo lee la caja de los pasos del cierre.
const checks = new CloseCheckService(prisma, {} as never, { get: () => undefined } as never);
const nights = new NightsService(prisma as never, reports, { log: async () => undefined } as never, checks);

function sys<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't', acrossVenues: true });
    return prisma.asSystem(() => fn());
  });
}

const r = randomUUID().slice(0, 6);
const T = (iso: string) => new Date(iso);
let C: string, lola: string, night2: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    await prisma.asSystem(async (tx) => {
      C = (await tx.venue.create({ data: { name: 'Local N', slug: `n-${r}` } })).id;
      const owner = (await tx.user.create({ data: { tenantId: C, email: `on-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      lola = (await tx.user.create({ data: { tenantId: C, email: `ln-${r}@x.es`, displayName: 'Lola', passwordHash: 'x', role: 'OPERATOR' } })).id;
      const term = (await tx.terminal.create({ data: { tenantId: C, externalId: `TN-${r}`, label: 'T' } })).id;
      const W = (await tx.clientWallet.create({ data: { tenantId: C, balanceCents: 1000, qrToken: `wn-${r}` } })).id;
      // Noche 1: cerrada sola a las 08:00 del 13; su Z se generó a las 08:10.
      await tx.venueNight.create({ data: { tenantId: C, openedAt: T('2026-10-12T20:00:00Z'), closedAt: T('2026-10-13T06:00:00Z'), autoClosed: true,
        zReport: { generatedAt: '2026-10-13T06:10:00.000Z', summary: { count: 2 } } } });
      night2 = (await tx.venueNight.create({ data: { tenantId: C, openedAt: T('2026-10-13T20:00:00Z') } })).id;
      let k = 0;
      const pay = async (amount: number, authorizedAt: string, eventAt: string) => {
        const p = await tx.payment.create({ data: { tenantId: C, terminalId: term, idempotencyKey: `pn-${r}-${k++}`, amountCents: amount,
          availableAmountCents: amount, qrToken: `qn-${r}-${k}`, qrExpiresAt: T('2026-10-20T00:00:00Z'), status: 'AUTHORIZED',
          provider: 'REDSYS', providerTxId: `N${r}${k}`, createdAt: T(authorizedAt), authorizedAt: T(authorizedAt), revenueCategory: 'VENUE_BAR' } });
        await tx.paymentEvent.create({ data: { paymentId: p.id, tenantId: C, eventType: 'payment.authorized', payload: {}, traceId: 't', occurredAt: T(eventAt) } });
        return p;
      };
      await pay(1100, '2026-10-13T02:00:00Z', '2026-10-13T02:00:00Z'); // en el Z 1
      await pay(1200, '2026-10-13T05:30:00Z', '2026-10-13T06:05:00Z'); // apuntado antes del Z 1 (08:10): lo contó él
      await pay(5000, '2026-10-13T03:00:00Z', '2026-10-13T09:00:00Z'); // aviso tardío → ajuste del Z 2
      await pay(3000, '2026-10-13T21:00:00Z', '2026-10-13T21:00:00Z'); // noche 2
      await pay(700, '2026-10-13T23:00:00Z', '2026-10-14T06:30:00Z'); // noche 2, apuntado tras las 08:00 pero antes del Z (09:00)
      await pay(900, '2026-10-14T05:00:00Z', '2026-10-14T10:00:00Z'); // noche 2 por fecha, apuntado tras su Z → ajuste del Z 3
      const old = await pay(2000, '2026-10-09T22:00:00Z', '2026-10-09T22:00:00Z');
      await tx.refund.create({ data: { tenantId: C, paymentId: old.id, amountCents: 2000, requestedBy: owner, status: 'SUCCEEDED',
        registeredManually: true, bankRefundedAt: T('2026-10-10T12:00:00Z'), createdAt: T('2026-10-13T21:30:00Z') } }); // con fecha atrás → ajuste
      await tx.refund.create({ data: { tenantId: C, paymentId: old.id, amountCents: 1, requestedBy: owner, status: 'SUCCEEDED',
        createdAt: T('2026-10-13T03:00:00Z') } }); // en el Z 1
      const c = await tx.walletConsumption.create({ data: { tenantId: C, walletId: W, amountCents: 3000, tipCents: 500, providedByUserId: lola,
        category: 'CHICA_SERVICE', createdAt: T('2026-10-13T02:30:00Z'), reversedAt: T('2026-10-13T22:00:00Z'), reversedByUserId: owner } });
      await tx.operatorEarning.create({ data: { tenantId: C, operatorId: lola, consumptionId: c.id, paymentAmountCents: 3000, commissionBps: 9000,
        commissionCents: 2700, tipCents: 500, reversedCents: 3200 } });
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Z de las noches con ajustes (Postgres real)', () => {
  it('la noche 2 se cierra sola: su Z con lo suyo y los ajustes de la noche 1 apuntados tarde', async () => {
    expect(await sys(() => nights.autoCloseDue(C, T('2026-10-14T07:00:00Z')))).toBe(1);
    const n2 = await sys(() => prisma.venueNight.findUnique({ where: { id: night2 } }));
    const z = n2!.zReport as unknown as NightZ;
    expect(z.from).toBe('2026-10-13T06:00:00.000Z');
    expect(z.to).toBe('2026-10-14T06:00:00.000Z');
    // 30 € + 7 € (apuntado antes de generar el Z); no los 9 € apuntados después.
    expect(z.summary).toMatchObject({ count: 2, grossCents: 3700, refundsCents: 0 });
    expect(z.adjustments).toMatchObject({
      since: '2026-10-13T06:10:00.000Z',
      before: '2026-10-13T06:00:00.000Z',
      count: 3,
      reversedConsumptionsCount: 1,
      reversedConsumptionsCents: 3500,
      reversedConsumptionsChicaCents: 3200,
    });
    expect(z.adjustments!.summary).toMatchObject({ count: 1, grossCents: 5000, refundsCount: 1, refundsCents: 2000, netCents: 3000 });
  });

  it('el cobro apuntado después del Z 2 con su fecha irá como ajuste del Z 3', async () => {
    const late = await sys(() =>
      reports.ajustes(C, { before: T('2026-10-14T06:00:00Z'), since: T('2026-10-14T07:00:00Z'), until: T('2026-10-15T07:00:00Z') }),
    );
    expect(late.cobros.map((c) => c.amountCents)).toEqual([900]);
    expect(late.devoluciones).toHaveLength(0);
    expect(late.consumosAnulados).toHaveLength(0);
  });
});
