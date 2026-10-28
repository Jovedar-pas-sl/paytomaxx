import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { MoneyMapService } from './money-map.service';
import { conceptsTotal } from '@nightpay/contracts';
import { buildMoneyMap, oxioPayCentsOf } from './money-map-rules';
import { REPORT_TX } from '../reports/reporting-sql';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NIGHT = '22222222-2222-4222-8222-222222222222';
const T = (iso: string) => new Date(iso);
const NOW = T('2026-10-25T01:00:00Z');

interface Fake {
  open?: unknown;
  lastClosed?: unknown;
  previous?: unknown;
  byId?: unknown;
}

/** Prisma de mentira: las noches con findFirst y cada consulta cruda por su texto. */
function makeService(fake: Fake = {}, opts: { bankFeeBps?: number } = {}) {
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...values);
    queries.push(q);
    if (q.text.includes('FROM payments p') && q.text.includes('approvedPayMethod')) {
      return [
        {
          amountCents: 15_000,
          tipCents: 500,
          category: 'CHICA_SERVICE',
          captureMethod: 'QR',
          posOperationNumber: null,
          platformBps: null,
          approvedPayMethod: 'wallet',
          lines: [
            { category: 'CHICA_SERVICE', amountCents: 12_000 },
            { category: 'VENUE_ROOM', amountCents: 3_000 },
          ],
        },
        { amountCents: 1_000, tipCents: 0, category: 'VENUE_BAR', captureMethod: 'POS_EXTERNAL', posOperationNumber: '9', platformBps: 500, approvedPayMethod: null, lines: null },
      ];
    }
    if (q.text.includes('FROM wallet_consumptions c') && q.text.includes('json_agg')) {
      return [{ amountCents: 2_000, tipCents: 0, category: 'VENUE_BAR', lines: [{ category: 'VENUE_BAR', amountCents: 2_000 }] }];
    }
    if (q.text.includes('WITH recargas')) {
      return [{ cardCount: 1, cardCents: 10_000n, cashCount: 1, cashCents: 5_000n, refundCount: 1, refundCents: 1_000n, walletCashCount: 0, walletCashCents: 0n, walletCardCents: 0n }];
    }
    if (q.text.includes('FROM operator_earnings e') && q.text.includes('GROUP BY 1')) {
      return [
        { chica: true, gross: 11_300n, unpaid: 11_300n },
        { chica: false, gross: 200n, unpaid: 0n },
      ];
    }
    if (q.text.includes('FROM operator_payouts po')) return [{ chica: false, rail: 'MANUAL_CASH', count: 1, cents: 200n }];
    if (q.text.includes('FROM client_wallets')) return [{ cents: 13_000n }];
    if (q.text.includes('earning_reversals')) return [{ chica: true, cents: 40_000n }];
    return [];
  });
  const tx = {
    $queryRaw,
    venue: { findUnique: vi.fn().mockResolvedValue({ platformCommissionBps: 1000 }) },
    venueNight: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        if (w.id) return fake.byId ?? null;
        if (w.closedAt === null) return fake.open ?? null;
        const closed = w.closedAt as { lte?: Date };
        if (closed?.lte) return fake.previous ?? null;
        return fake.lastClosed ?? null;
      }),
    },
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    withTenant: vi.fn(async (tenantId: string, fn: (t: unknown) => unknown) => {
      expect(tenantId).toBe(TENANT);
      return fn(tx);
    }),
  };
  const reports = {
    recargasEfectivo: vi.fn().mockResolvedValue([{ amountCents: 5_000 }]),
    pagosSaldo: vi.fn().mockResolvedValue([]),
    liquidaciones: vi.fn().mockResolvedValue([{ externalRail: 'MANUAL_CASH', totalCents: 200 }]),
  };
  const config = { get: vi.fn((k: string) => (k === 'BANK_CARD_FEE_BPS' ? opts.bankFeeBps : undefined)) };
  return { svc: new MoneyMapService(prisma as never, reports as never, config as never), queries, reports, tx, prisma };
}

/** Cada tabla leída va filtrada por el local, con el local como parámetro (nada del middleware). */
function expectTenantScoped(q: Prisma.Sql): void {
  const tables: Array<[string, string]> = [
    ['FROM payments p', 'p."tenantId" = $'],
    ['FROM refunds r', 'r."tenantId" = $'],
    ['FROM wallet_payouts wp', 'wp."tenantId" = $'],
    ['FROM wallet_consumptions c', 'c."tenantId" = $'],
    ['FROM wallet_cash_topups ct', 'ct."tenantId" = $'],
    ['FROM operator_earnings e', 'e."tenantId" = $'],
    ['FROM operator_payouts po', 'po."tenantId" = $'],
    ['FROM client_wallets', '"tenantId" = $'],
  ];
  for (const [from, filter] of tables) {
    if (q.text.includes(from)) expect(q.text).toContain(filter);
  }
  expect(q.values).toContain(TENANT);
}

describe('GET /v1/admin/money-map: la noche abierta', () => {
  it('en directo desde el cierre de la noche anterior (como su Z), con la caja del cierre y el saldo vivo', async () => {
    const { svc, queries, reports } = makeService({
      open: { id: NIGHT, openedAt: T('2026-10-24T20:00:00Z'), openingFloatCents: 10_000, closedAt: null },
      previous: { closedAt: T('2026-10-24T06:00:00Z'), zReport: { generatedAt: '2026-10-24T06:00:00.000Z' } },
    });
    const m = await svc.forQuery(TENANT, {}, NOW);
    expect(m.scope).toEqual({ kind: 'night', nightId: NIGHT, open: true });
    expect(m.from).toBe('2026-10-24T06:00:00.000Z');
    expect(m.to).toBe(NOW.toISOString());
    expect(m.frozen).toBe(false);
    // Tarjeta (datáfono) + Apple Pay + del saldo; recargas aparte.
    expect(m.inflow).toMatchObject({ mobileWalletCents: 15_500, posCents: 1_000, saldoCents: 2_000, topUps: { totalCents: 15_000, count: 2 } });
    expect(m.salesCents).toBe(18_500);
    // OxioPay: 10 % (el del local) del pack, 5 % (el del cobro) del datáfono y 10 % del saldo.
    expect(m.split.commissions).toEqual({ platformCents: 1_500 + 50 + 200, bankCents: null, totalCents: 1_750 });
    expect(m.split).toMatchObject({ chicasCents: 11_300, camarerosCents: 200 });
    // Caja: fondo 100 + 50 de recargas − 2 pagados al camarero en efectivo.
    expect(m.where.cashBoxCents).toBe(14_800);
    expect(m.where.cashBox).toEqual({ openingFloatCents: 10_000, inCents: 5_000, outCents: 200 });
    expect(m.where.liveSaldoCents).toBe(13_000);
    expect(m.where.owed).toEqual({ chicasCents: 40_000, camarerosCents: 0 });
    expect(m.outflow.payouts).toEqual([{ who: 'camareros', rail: 'MANUAL_CASH', count: 1, cents: 200 }]);
    expect(reports.recargasEfectivo).toHaveBeenCalledWith(TENANT, { from: T('2026-10-24T06:00:00Z'), to: NOW }, { recordedBefore: NOW });
    for (const q of queries) expectTenantScoped(q);
    // Para un Z: lo apuntado antes del corte.
    const sales = queries.find((q) => q.text.includes('approvedPayMethod'))!;
    expect(sales.text).toContain('payment_events');
    expect(sales.text).toContain('"walletId" IS NULL');
  });

  it('sin noche abierta: desde el último cierre', async () => {
    const { svc } = makeService({ lastClosed: { closedAt: T('2026-10-24T05:30:00Z') } });
    const m = await svc.forQuery(TENANT, { night: 'current' }, NOW);
    expect(m.scope).toEqual({ kind: 'night', nightId: null, open: false });
    expect(m.from).toBe('2026-10-24T05:30:00.000Z');
    expect(m.where.cashBox.openingFloatCents).toBeNull();
  });

  it('sin ninguna noche: desde las últimas 08:00 de Madrid', async () => {
    const { svc } = makeService();
    const m = await svc.forQuery(TENANT, {}, NOW);
    expect(m.from).toBe('2026-10-24T06:00:00.000Z');
  });

  it('con la tasa del banco configurada, la calcula', async () => {
    const { svc } = makeService({}, { bankFeeBps: 100 });
    const m = await svc.forQuery(TENANT, {}, NOW);
    // 1 % de (155 + 10 €) de ventas con tarjeta + 100 € de recargas.
    expect(m.split.commissions.bankCents).toBe(265);
  });
});

describe('GET /v1/admin/money-map?night=<id>', () => {
  it('cerrada con el mapa congelado: el del Z, tal cual', async () => {
    const frozen = buildMoneyMap({
      scope: { kind: 'night', nightId: NIGHT, open: false },
      window: { from: T('2026-10-23T06:00:00Z'), to: T('2026-10-24T05:00:00Z') },
      now: T('2026-10-24T05:00:00Z'),
      frozen: true,
      sales: [],
      topUps: { cardCents: 0, cardCount: 0, cashCents: 0, cashCount: 0 },
      staff: { chicas: { grossCents: 0, unpaidCents: 0 }, camareros: { grossCents: 0, unpaidCents: 0 } },
      cardRefunds: { cents: 0, count: 0 },
      walletPayouts: { cashCents: 0, cashCount: 0, cardCents: 0 },
      payouts: [],
      cashBox: { openingFloatCents: null, inCents: 0, outCents: 0, expectedCents: 0 },
      bankFeeBps: null,
      liveSaldoCents: 900,
      owed: null,
    });
    const { svc, queries } = makeService({ byId: { id: NIGHT, openedAt: T('2026-10-23T20:00:00Z'), closedAt: T('2026-10-24T05:00:00Z'), zReport: { moneyMap: frozen } } });
    const m = await svc.forQuery(TENANT, { night: NIGHT }, NOW);
    expect(m).toEqual(frozen);
    expect(queries).toHaveLength(0);
  });

  it('cerrada antes del mapa: se calcula con la ventana, el corte y la caja de su Z (sin saldo de ahora)', async () => {
    const { svc, reports, queries } = makeService({
      byId: {
        id: NIGHT,
        openedAt: T('2026-10-23T20:00:00Z'),
        closedAt: T('2026-10-24T05:00:00Z'),
        openingFloatCents: 5_000,
        zReport: {
          from: '2026-10-23T06:00:00.000Z',
          to: '2026-10-24T05:00:00.000Z',
          generatedAt: '2026-10-24T05:00:01.000Z',
          caja: { openingFloatCents: 5_000, cashInCents: 100, cashOutCents: 0, expectedCents: 5_100 },
        },
      },
    });
    const m = await svc.forQuery(TENANT, { night: NIGHT }, NOW);
    expect(m.frozen).toBe(false);
    expect(m.scope).toEqual({ kind: 'night', nightId: NIGHT, open: false });
    expect(m.from).toBe('2026-10-23T06:00:00.000Z');
    expect(m.to).toBe('2026-10-24T05:00:00.000Z');
    expect(m.where.cashBoxCents).toBe(5_100);
    expect(m.where.liveSaldoCents).toBeNull();
    expect(m.where.owed).toBeNull();
    expect(reports.recargasEfectivo).not.toHaveBeenCalled();
    expect(queries.some((q) => q.text.includes('FROM client_wallets'))).toBe(false);
    expect(queries.find((q) => q.text.includes('approvedPayMethod'))!.values).toContainEqual(T('2026-10-24T05:00:01.000Z'));
  });

  it('abierta: como la de en directo', async () => {
    const { svc } = makeService({ byId: { id: NIGHT, openedAt: T('2026-10-24T20:00:00Z'), closedAt: null, openingFloatCents: null } });
    const m = await svc.forQuery(TENANT, { night: NIGHT }, NOW);
    expect(m.scope).toEqual({ kind: 'night', nightId: NIGHT, open: true });
    expect(m.from).toBe('2026-10-24T20:00:00.000Z');
  });

  it('de otro local (o que no existe): 404', async () => {
    const { svc } = makeService();
    await expect(svc.forQuery(TENANT, { night: NIGHT }, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GET /v1/admin/money-map?from&to', () => {
  it('unas fechas pasadas: días de Madrid, sin saldo de ahora', async () => {
    const { svc } = makeService();
    const m = await svc.forQuery(TENANT, { from: '2026-10-01', to: '2026-10-02' }, NOW);
    expect(m.scope).toEqual({ kind: 'period' });
    expect(m.from).toBe('2026-09-30T22:00:00.000Z');
    expect(m.to).toBe('2026-10-02T22:00:00.000Z');
    expect(m.where.liveSaldoCents).toBeNull();
    expect(m.where.cashBox.openingFloatCents).toBeNull();
  });

  it('hasta hoy: hasta ahora, con el saldo vivo', async () => {
    const { svc } = makeService();
    const m = await svc.forQuery(TENANT, { from: '2026-10-24', to: '2026-10-25' }, NOW);
    expect(m.to).toBe(NOW.toISOString());
    expect(m.where.liveSaldoCents).toBe(13_000);
  });

  it('fechas imposibles o al revés: 400', async () => {
    const { svc } = makeService();
    await expect(svc.forQuery(TENANT, { from: '2026-10-05', to: '2026-10-01' }, NOW)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.forQuery(TENANT, { from: '2026-02-30', to: '2026-03-01' }, NOW)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('local que no existe', () => {
  it('404', async () => {
    const { svc, tx } = makeService();
    tx.venue.findUnique.mockResolvedValueOnce(null);
    await expect(svc.forQuery(TENANT, {}, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('transacciones del mapa del dinero: tope explícito (DI-02)', () => {
  it('las del cálculo llevan REPORT_TX (el Z congela el mapa al cerrar)', async () => {
    const { svc, prisma } = makeService();
    await svc.forQuery(TENANT, { from: '2026-10-01', to: '2026-10-02' }, NOW);
    expect(prisma.withTenant.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of prisma.withTenant.mock.calls) expect((call as unknown[])[2]).toBe(REPORT_TX);
  });
});

describe('lo de OxioPay de un periodo (oxioPayOwed, la «Liquidación OxioPay»)', () => {
  const window = { from: T('2026-10-19T06:00:00Z'), to: T('2026-10-26T07:00:00Z') };
  const period = { scope: { kind: 'period' } as const, now: NOW, openingFloatCents: null, withLiveBalances: false };

  it('las mismas filas y cuentas que el mapa del mismo periodo: suma lo que el mapa pone como de OxioPay', async () => {
    const { svc } = makeService();
    const map = await svc.compute(TENANT, window, period);
    const owed = await svc.oxioPayOwed(TENANT, window);
    expect(conceptsTotal(owed)).toBe(oxioPayCentsOf(map));
    // 10 % del local en el pack (150 €) y en el consumo (20 €); 5 % fijado en el datáfono (10 €).
    expect(owed).toMatchObject({ platformSales: 1_500 + 50, platformSaldo: 200 });
  });

  it('con otro % del local (el de la semana ya liquidada) solo cambia lo que no lo lleva fijado', async () => {
    const { svc } = makeService();
    const owed = await svc.oxioPayOwed(TENANT, window, { platformBps: 800 });
    expect(owed).toMatchObject({ platformSales: 1_200 + 50, platformSaldo: 160 });
    const map = await svc.compute(TENANT, window, { ...period, platformBps: 800 });
    expect(conceptsTotal(owed)).toBe(oxioPayCentsOf(map));
  });
});
