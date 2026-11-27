// Integración (Postgres real, FORCE RLS): el cierre a ciegas de la encargada. Con la noche abierta,
// el API no le da ninguna cifra del efectivo (close-check), «Ver si cuadra» lo dice el API sin lo
// esperado y cada recuento queda en el registro: el primero va al Z aunque el panel no lo mande.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConflictException, type HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { NightCloseStep } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { NightsController } from '../../src/modules/nights/nights.controller';
import { NightsService } from '../../src/modules/nights/nights.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { PeriodReportsController } from '../../src/modules/reports/period-reports.controller';
import { PeriodReportsService } from '../../src/modules/reports/period-reports.service';
import { ReportsController } from '../../src/modules/reports/reports.controller';
import { madridDay } from '../../src/common/time/madrid';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const config = { get: () => undefined, getOrThrow: () => undefined };
const reports = new ReportsService(prisma);
const incidents = new IncidentsService(prisma, audit);
const checks = new CloseCheckService(prisma, incidents, config as never);
const nights = new NightsService(prisma, reports, audit, checks);
const controller = new NightsController(nights);
vi.spyOn(nights as unknown as { safeAutoClose(tenantId: string): Promise<void> }, 'safeAutoClose').mockResolvedValue(undefined);

const r = randomUUID().slice(0, 6);
let tenantId: string;
let manager: string;
let owner: string;

function asStaff<T>(fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-ciegas-${r}`, tenantId });
    return fn();
  });
}
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-seed' });
    return prisma.asSystem(fn);
  });
}
const as = (role: 'OWNER' | 'MANAGER') => ({ sub: role === 'OWNER' ? owner : manager, tenantId, role }) as never;
const efectivo = (steps: NightCloseStep[]) => steps.find((s) => s.key === 'efectivo')!;

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ tenantId, manager, owner } = await seed(async (tx) => {
    const id = (await tx.venue.create({ data: { name: 'Local ciegas', slug: `cc-${r}`, walletGroup: `gcc-${r}`, payoutHoldDays: 0 } })).id;
    const user = (role: 'OWNER' | 'MANAGER') =>
      tx.user.create({ data: { tenantId: id, email: `${role.toLowerCase()}-cc-${r}@x.es`, passwordHash: 'x', role } as never });
    return { tenantId: id, owner: (await user('OWNER')).id, manager: (await user('MANAGER')).id };
  }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cierre a ciegas de la encargada (Postgres real)', () => {
  it('close-check sin cifras, «Ver si cuadra» sin lo esperado y el primer recuento del registro al Z', async () => {
    // Fondo 100 € y 177 € de recargas en efectivo: debería haber 277 €.
    const night = await asStaff(() => nights.open(tenantId, manager, 10_000));
    const wallet = await seed((tx) =>
      tx.clientWallet.create({
        data: { tenantId, balanceCents: 17_700, qrToken: `ccw-${r}`, shortCode: `C${r}`.slice(0, 6).toUpperCase(), walletGroup: `gcc-${r}` },
      }),
    );
    await seed((tx) =>
      tx.walletCashTopUp.create({ data: { tenantId, walletId: wallet.id, amountCents: 17_700, takenByUserId: manager, idempotencyKey: `cc-${r}` } }),
    );
    await new Promise((res) => setTimeout(res, 50));

    // El dueño lo ve todo.
    const full = await asStaff(() => controller.closeCheck(as('OWNER')));
    expect(full.cash).toMatchObject({ openingFloatCents: 10_000, cashInCents: 17_700, expectedCents: 27_700 });

    // La encargada: ni el fondo, ni lo que entró, ni lo esperado (en ninguna parte de la respuesta).
    const blind = await asStaff(() => controller.closeCheck(as('MANAGER')));
    expect(blind.cash).toMatchObject({ cashHidden: true, floatRecorded: true, countRequired: true, openingFloatCents: null, expectedCents: 0 });
    expect(efectivo(blind.steps)).toMatchObject({ status: 'block', items: [] });
    const json = JSON.stringify(blind);
    for (const leak of ['10000', '17700', '27700', '100,00', '177,00', '277,00']) expect(json).not.toContain(leak);

    // «Ver si cuadra» con 0 (para sacar lo esperado restando): se dice la diferencia, pero queda en el registro.
    const probe = await asStaff(() => controller.cashCount(as('MANAGER'), { countedCents: 0 }));
    expect(probe).toMatchObject({ status: 'warn', reason: 'short', diffCents: -27_700 });
    // Con otro fondo: no deja (lo aprueba el dueño) y no dice cuál era.
    const otherFloat = await asStaff(() => controller.cashCount(as('MANAGER'), { countedCents: 27_700, openingFloatCents: 5_000 }));
    expect(otherFloat).toMatchObject({ status: 'block', reason: 'float-changed', diffCents: null });
    expect(otherFloat.detail).not.toContain('100,00');
    const ok = await asStaff(() => controller.cashCount(as('MANAGER'), { countedCents: 27_700 }));
    expect(ok).toMatchObject({ status: 'ok', reason: 'matches', diffCents: 0 });

    // Si no deja cerrar, el paso «Efectivo» del 409 tampoco lleva cifras.
    const err = (await asStaff(() => controller.close(as('MANAGER'), night.id, { acknowledged: [] }))
      .then(() => null, (e: unknown) => e)) as HttpException;
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/277,00|177,00|100,00/);

    // Cierra con lo contado bien, sin decir el primer recuento: el Z guarda el del registro (0 €).
    const closed = await asStaff(() => controller.close(as('MANAGER'), night.id, { acknowledged: [], cashCountedCents: 27_700 }));
    expect(closed.z.caja).toMatchObject({ expectedCents: 27_700, countedCents: 27_700, firstCountedCents: 0, diffCents: 0 });
  });

  it('las métricas del panel y los CSV de efectivo: a ciegas para la encargada con la noche abierta', async () => {
    const metrics = new PeriodReportsController(new PeriodReportsService(prisma));
    const csv = new ReportsController(reports);
    const sent: { body?: string } = {};
    const reply = { status: () => reply, header: () => reply, send: (b: string) => ((sent.body = b), reply) } as never;
    await asStaff(() => nights.open(tenantId, manager, 5_000));
    const wallet = await seed((tx) =>
      tx.clientWallet.create({
        data: { tenantId, balanceCents: 4_400, qrToken: `ccw2-${r}`, shortCode: `D${r}`.slice(0, 6).toUpperCase(), walletGroup: `gcc-${r}` },
      }),
    );
    await seed((tx) =>
      tx.walletCashTopUp.create({ data: { tenantId, walletId: wallet.id, amountCents: 4_400, takenByUserId: manager, idempotencyKey: `cc2-${r}` } }),
    );
    await new Promise((res) => setTimeout(res, 50));

    // Hoy lleva las dos recargas en efectivo (177 € de la noche cerrada + 44 € de esta).
    const full = await asStaff(() => metrics.metrics(as('OWNER'), tenantId));
    expect(full.today.walletCashTopUpCents).toBe(22_100);
    const blind = await asStaff(() => metrics.metrics(as('MANAGER'), tenantId));
    expect(blind).toMatchObject({ cashHidden: true, today: { walletCashTopUpCents: 0, walletCashPayoutCents: 0, chargedCents: 0 } });
    expect(JSON.stringify(blind)).not.toMatch(/22100|4400|17700/);

    const today = madridDay(new Date());
    const err = await asStaff(() => csv.export(as('MANAGER'), tenantId, 'recargas-efectivo', today, today, reply)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toMatch(/Se ve al cerrar la noche/);
    await asStaff(() => csv.export(as('OWNER'), tenantId, 'recargas-efectivo', today, today, reply));
    expect(sent.body).toContain('44,00');
  });
});
