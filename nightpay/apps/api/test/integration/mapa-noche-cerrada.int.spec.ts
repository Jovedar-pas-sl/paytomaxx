// Integración (Postgres real, FORCE RLS): el mapa del dinero de una noche cerrada sin mapa
// congelado (los Z de antes del 24-oct-2026) se calcula con el corte de su Z. Una devolución
// apuntada después del Z no cambia esa noche: ni lo devuelto ni la comisión de OxioPay
// (va como ajuste, como en la liquidación).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { ReportsService } from '../../src/modules/reports/reports.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const moneyMap = new MoneyMapService(prisma, new ReportsService(prisma), { get: () => undefined } as never);

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
let tenantId: string;
let owner: string;
let paymentId: string;
let nightId: string;

function asStaff<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-mnc-${r}`, tenantId });
    return fn();
  });
}
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-seed' });
    return prisma.asSystem(fn);
  });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ tenantId, owner, paymentId, nightId } = await seed(async (tx) => {
    const id = (
      await tx.venue.create({ data: { name: 'Local mapa cerrado', slug: `mnc-${r}`, walletGroup: `gmnc-${r}`, platformCommissionBps: 1000 } as never })
    ).id;
    const own = (await tx.user.create({ data: { tenantId: id, email: `owner-mnc-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } as never })).id;
    const term = (await tx.terminal.create({ data: { tenantId: id, externalId: `TMNC-${r}`, label: 'Barra' } })).id;
    // 100 € de barra a las 3 h; la noche se cerró hace 1 h (su Z, sin mapa congelado: de antes del mapa).
    const at = ago(3 * HOUR);
    const p = await tx.payment.create({
      data: {
        tenantId: id, terminalId: term, idempotencyKey: `mnc-${r}`, qrToken: `mnc-${r}`, qrExpiresAt: new Date(at.getTime() + HOUR),
        amountCents: 10_000, availableAmountCents: 10_000, status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `MNC${r}`,
        revenueCategory: 'VENUE_BAR', platformCommissionBps: 1000, createdAt: at, authorizedAt: at,
      } as never,
    });
    const from = ago(4 * HOUR);
    const closedAt = ago(HOUR);
    const n = await tx.venueNight.create({
      data: {
        tenantId: id, openedAt: from, closedAt, closedBy: own, autoClosed: false,
        zReport: { from: from.toISOString(), to: closedAt.toISOString(), generatedAt: closedAt.toISOString() },
      } as never,
    });
    return { tenantId: id, owner: own, paymentId: p.id, nightId: n.id };
  }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('mapa del dinero de una noche cerrada sin mapa guardado (Postgres real)', () => {
  it('una devolución apuntada después del Z no rebaja la comisión de esa noche', async () => {
    const before = await asStaff(() => moneyMap.forQuery(tenantId, { night: nightId }));
    expect(before.frozen).toBe(false);
    expect(before.split.commissions.platformCents).toBe(1_000);

    // Media hora después del cierre, se devuelven 40 €.
    await seed((tx) =>
      tx.refund.create({ data: { tenantId, paymentId, amountCents: 4_000, requestedBy: owner, status: 'SUCCEEDED', createdAt: ago(HOUR / 2) } as never }),
    );
    const after = await asStaff(() => moneyMap.forQuery(tenantId, { night: nightId }));
    expect(after.split.commissions.platformCents).toBe(1_000);
    expect(after.split).toEqual(before.split);
    expect(after.outflow.refunds).toEqual(before.outflow.refunds);

    // En unas fechas (sin corte) la devolución sí cuenta: ahí va como ajuste.
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(ago(HOUR / 2));
    const period = await asStaff(() => moneyMap.forQuery(tenantId, { from: day, to: day }));
    expect(period.outflow.refunds.cardCents).toBeGreaterThanOrEqual(4_000);
  });
});
