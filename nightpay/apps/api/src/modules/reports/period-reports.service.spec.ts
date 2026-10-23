import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { PeriodReportsService } from './period-reports.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

const TOTALS_ROW = {
  paymentCount: 2,
  grossCents: 13_000n,
  tipCents: 500n,
  refundCount: 0,
  refundedCents: 0n,
  refundedTipCents: 0n,
  walletCashPayoutCount: 1,
  walletCashPayoutCents: 8000n,
  walletCashTopUpCount: 0,
  walletCashTopUpCents: 0n,
  walletCardPayoutCount: 0,
  walletCardPayoutCents: 0n,
  walletCardTopUpCount: 0,
  walletCardTopUpCents: 0n,
};

/** Prisma con $queryRaw de mentira: guarda cada consulta (texto + parámetros). */
function makeService(venue = { name: 'Local Centro', vatBps: 2100, vatRegime: 'GENERAL' }) {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      queries.push(q);
      if (q.text.includes('WITH cobros')) return [TOTALS_ROW];
      if (q.text.includes('GROUP BY p.status')) return [{ status: 'AUTHORIZED', count: 2 }];
      return [];
    }),
    venue: { findUniqueOrThrow: vi.fn().mockResolvedValue(venue) },
    withTenant: vi.fn(),
  };
  // Las lecturas de tablas con RLS forzado van con el local en la sesión: misma consulta.
  prisma.withTenant.mockImplementation(async (tenantId: string, fn: (tx: unknown) => unknown) => {
    expect(tenantId).toBe(TENANT);
    return fn(prisma);
  });
  return { svc: new PeriodReportsService(prisma as never), queries };
}

/** Cada tabla leída va filtrada por el local, con el local como parámetro (nada del middleware). */
function expectTenantScoped(q: Prisma.Sql): void {
  const tables: Array<[string, string]> = [
    ['FROM payments p', 'p."tenantId" = $'],
    ['FROM refunds r', 'r."tenantId" = $'],
    ['FROM wallet_payouts wp', 'wp."tenantId" = $'],
    ['FROM wallet_consumptions c', 'c."tenantId" = $'],
    ['FROM operator_earnings e', 'e."tenantId" = $'],
    ['FROM operator_payouts po', 'po."tenantId" = $'],
  ];
  for (const [from, filter] of tables) {
    if (q.text.includes(from)) expect(q.text).toContain(filter);
  }
  expect(q.values).toContain(TENANT);
}

describe('métricas del panel', () => {
  it('hoy desde las 00:00 de Madrid (no del servidor) y semana de 7 días más hoy', async () => {
    const { svc, queries } = makeService();
    // 01:30 de Madrid del 26-oct (ya en horario de invierno).
    const now = new Date('2026-10-26T00:30:00Z');
    const m = await svc.metrics(TENANT, now);
    const totals = queries.filter((q) => q.text.includes('WITH cobros'));
    expect(totals).toHaveLength(2);
    expect(totals[0]!.values).toContain(now);
    expect(totals[0]!.values).toContainEqual(new Date('2026-10-25T23:00:00Z'));
    // 19-oct a las 00:00 de Madrid, aún en verano.
    expect(totals[1]!.values).toContainEqual(new Date('2026-10-18T22:00:00Z'));
    expect(m.today).toMatchObject({ count: 2, chargedCents: 13_500, netCents: 5500 });
    expect(m.statusBreakdown).toEqual({ AUTHORIZED: 2 });
    queries.forEach(expectTenantScoped);
  });
});

describe('Z de un periodo', () => {
  it('todas las consultas filtran por el local, también los consumos del saldo', async () => {
    const { svc, queries } = makeService();
    const window = { from: new Date('2026-10-13T22:00:00Z'), to: new Date('2026-10-14T06:00:00Z') };
    const z = await svc.periodZ(TENANT, window, window.to);
    expect(queries).toHaveLength(5);
    queries.forEach(expectTenantScoped);
    expect(queries.some((q) => q.text.includes('FROM wallet_consumptions c'))).toBe(true);
    expect(z.summary).toMatchObject({ paymentCount: 2, walletCashPayoutCents: 8000, netCents: 5500 });
    expect(z.payouts).toEqual({ count: 0, totalCents: 0 });
  });
});

describe('IVA 303', () => {
  it('un total por cada mes de Madrid y los consumos del trimestre, todo del local', async () => {
    const { svc, queries } = makeService();
    const r = await svc.vat303(TENANT, 'Q2-2026', new Date('2026-07-02T10:00:00Z'));
    const totals = queries.filter((q) => q.text.includes('WITH cobros'));
    expect(totals.map((q) => q.values.filter((v) => v instanceof Date)[0])).toEqual([
      new Date('2026-03-31T22:00:00Z'),
      new Date('2026-04-30T22:00:00Z'),
      new Date('2026-05-31T22:00:00Z'),
    ]);
    queries.forEach(expectTenantScoped);
    if ('exento' in r) throw new Error('no es exento');
    expect(r.byMonth.map((m) => m.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    // 130 € − 80 € de saldo devuelto en efectivo, cada mes; propinas fuera.
    expect(r.byMonth[0]).toMatchObject({ facturadoCents: 5000, netCents: 5500 });
  });

  it('régimen exento: no consulta nada más', async () => {
    const { svc, queries } = makeService({ name: 'Local', vatBps: 0, vatRegime: 'EXENTO' });
    const r = await svc.vat303(TENANT, 'Q1-2026');
    expect(r).toMatchObject({ exento: true, quarter: 'Q1-2026' });
    expect(queries).toHaveLength(0);
  });
});
