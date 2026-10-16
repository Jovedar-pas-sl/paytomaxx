// Integración (Postgres real): consumos del saldo en informes y en «Mi noche». Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { NightsService } from '../../src/modules/nights/nights.service';
import { summarize } from '../../src/modules/reports/export-csv';

// «Mi noche» cuenta desde las 08:00 de Madrid si no hay noche abierta: el reloj
// se fija a las 23:00 para que la prueba no dependa de la hora a la que corre.
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-10-12T21:00:00Z'));

const cls = new ClsService(new AsyncLocalStorage());
 
const prisma = new PrismaService(cls as any);
const reports = new ReportsService(prisma as never);
const nights = new NightsService(prisma as never, reports, { log: async () => undefined } as never);

// Como una petición del panel o de la app de la chica: el local en el contexto
// (lo pone AuthGuard) y NADA de asSystem. La base es del rol dueño SIN
// superusuario (FORCE RLS sí aplica): informes y «Mi noche» leen
// wallet_consumptions y operator_earnings con el local en la sesión.
function asStaff<T>(tenantId: string, fn: (s: { reports: ReportsService; nights: NightsService }) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't', tenantId });
    return fn({ reports, nights });
  });
}

const r = randomUUID().slice(0, 6);
let A: string, lola: string, owner: string, term: string, wallet: string;
const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

beforeAll(async () => {
  await prisma.onModuleInit();
  await cls.run(async () => {
    cls.set('ctx', { traceId: 't' });
    await prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Local C', slug: `c-${r}` } })).id;
      owner = (await tx.user.create({ data: { tenantId: A, email: `o-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      lola = (await tx.user.create({ data: { tenantId: A, email: `lola-${r}@x.es`, displayName: 'Lola', passwordHash: 'x', role: 'OPERATOR' } })).id;
      term = (await tx.terminal.create({ data: { tenantId: A, externalId: `T-${r}`, label: 'T' } })).id;
      wallet = (await tx.clientWallet.create({ data: { tenantId: A, balanceCents: 10_000, qrToken: `wq-${r}` } })).id;
      // Cobro con tarjeta de Lola: 100 € + 5 € de propina, comisión 90 €.
      const p = await tx.payment.create({
        data: {
          tenantId: A, terminalId: term, idempotencyKey: `p-${r}`, amountCents: 10_000, tipCents: 500,
          availableAmountCents: 10_000, qrToken: `qr-${r}`, qrExpiresAt: minutesAgo(-60), status: 'AUTHORIZED',
          provider: 'REDSYS', providerTxId: `ORD${r}`, authorizedAt: minutesAgo(30), createdByUserId: lola,
          revenueCategory: 'CHICA_SERVICE',
        },
      });
      await tx.operatorEarning.create({
        data: { tenantId: A, operatorId: lola, paymentId: p.id, paymentAmountCents: 10_000, commissionBps: 9000, commissionCents: 9000, tipCents: 500 },
      });
      // Del saldo: 60 € + 10 € de propina (comisión 54 €), y otro anulado de 20 €.
      const c1 = await tx.walletConsumption.create({
        data: { tenantId: A, walletId: wallet, amountCents: 6000, tipCents: 1000, providedByUserId: lola, category: 'CHICA_SERVICE', createdAt: minutesAgo(20) },
      });
      await tx.operatorEarning.create({
        data: { tenantId: A, operatorId: lola, consumptionId: c1.id, paymentAmountCents: 6000, commissionBps: 9000, commissionCents: 5400, tipCents: 1000 },
      });
      const c2 = await tx.walletConsumption.create({
        data: { tenantId: A, walletId: wallet, amountCents: 2000, providedByUserId: lola, category: 'CHICA_SERVICE', createdAt: minutesAgo(10), reversedAt: minutesAgo(5), reversedByUserId: owner },
      });
      await tx.operatorEarning.create({
        data: { tenantId: A, operatorId: lola, consumptionId: c2.id, paymentAmountCents: 2000, commissionBps: 9000, commissionCents: 1800, reversedCents: 1800 },
      });
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  vi.useRealTimers();
});

describe('consumos del saldo en informes y en "Mi noche" (Postgres real)', () => {
  it('el informe trae el consumo con parte para la chica y no el anulado', async () => {
    const rows = await asStaff(A, ({ reports }) => reports.consumos(A, { from: minutesAgo(120), to: minutesAgo(-1) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: 6000, tipCents: 1000, commissionCents: 5400, earningTipCents: 1000, operatorName: 'Lola' });

    const cobros = await asStaff(A, ({ reports }) => reports.cobros(A, { from: minutesAgo(120), to: minutesAgo(-1) }));
    const s = summarize(cobros, [], [], rows);
    expect(s.chicaCommissionCents).toBe(9000 + 5400);
    expect(s.chicaTipsCents).toBe(500 + 1000);
    expect(s.perChica[0]).toMatchObject({ name: 'Lola', count: 2, commissionCents: 14_400 });
  });

  it('"Mi noche" de la chica suma tarjeta + saldo; el anulado no cuenta (como en el informe)', async () => {
    const mine = await asStaff(A, ({ nights }) => nights.mine(A, lola));
    expect(mine).toMatchObject({
      count: 2,
      chargedCents: 10_500 + 7000,
      commissionCents: 9000 + 5400,
      tipsCents: 500 + 1000,
      reversedCents: 0,
      netCents: 9000 + 5400 + 500 + 1000,
    });
  });
});
