import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { buildPeriodZ, type ZCategoryRow } from './period-reports';
import { PeriodReportsService } from './period-reports.service';
import { EMPTY_TOTALS, invoicedCents, totalsFromRow, type PeriodTotals, type PeriodTotalsRow } from './period-totals';
import { madridQuarter } from './reporting-window';
import { buildVat303, vatSplit, type Vat303Report } from './vat-303';

/**
 * IVA (modelo 303) y propinas en Sala Bambú (Madrid), 21 % general:
 *  facturado = importe (sin propinas) − (devuelto − propina devuelta) − saldo devuelto en efectivo;
 *  base = facturado / (1 + IVA) redondeado al céntimo; cuota = facturado − base.
 * Cada devolución cuenta en el mes en que se hizo en el banco.
 */

const TENANT = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const BAMBU = { name: 'Sala Bambú (Madrid)', vatBps: 2100, vatRegime: 'GENERAL' };
const NOW = new Date('2026-10-16T08:00:00Z');
const month = (o: Partial<PeriodTotals>): PeriodTotals => ({ ...EMPTY_TOTALS, ...o });

function vat(quarter: string, months: PeriodTotals[], venue = BAMBU): Vat303Report {
  const r = buildVat303({ quarter: madridQuarter(quarter), venue, months, consumptions: { count: 0, cents: 0 }, now: NOW });
  if ('exento' in r) throw new Error('no es exento');
  return r;
}

describe('propinas fuera de la base del IVA', () => {
  it('servicio de 150 € + 20 € de propina: base 123,97 € y cuota 26,03 €; la propina no cambia nada', () => {
    const conPropina = vat('Q4-2026', [month({ paymentCount: 1, grossCents: 15_000, tipCents: 2000 }), month({}), month({})]);
    const sinPropina = vat('Q4-2026', [month({ paymentCount: 1, grossCents: 15_000 }), month({}), month({})]);
    expect(conPropina.byMonth[0]).toMatchObject({ facturadoCents: 15_000, baseImponibleCents: 12_397, cuotaIvaCents: 2603 });
    expect(conPropina.modelo303).toEqual(sinPropina.modelo303);
    // La propina sí es dinero cobrado: va en el neto, aparte de lo facturado.
    expect(conPropina.breakdown).toMatchObject({ tipCents: 2000, netCobradoCents: 17_000, facturadoCents: 15_000 });
  });

  it('devolución total de 100 € + 10 € de propina: base y cuota a cero (la propina devuelta no resta de la base)', () => {
    const t = month({ paymentCount: 1, grossCents: 10_000, tipCents: 1000, refundCount: 1, refundedCents: 11_000, refundedTipCents: 1000 });
    expect(invoicedCents(t)).toBe(0);
    const r = vat('Q4-2026', [t, month({}), month({})]);
    expect(r.modelo303).toEqual({ baseImponibleCents: 0, cuotaIvaCents: 0, totalFacturadoCents: 0, ivaAIngresarCents: 0 });
    expect(r.breakdown.netCobradoCents).toBe(0);
  });

  it('devolución parcial de 55 € de 110 €: 5 € eran propina; base 41,32 € y cuota 8,68 €', () => {
    const t = month({ paymentCount: 1, grossCents: 10_000, tipCents: 1000, refundCount: 1, refundedCents: 5500, refundedTipCents: 500 });
    const r = vat('Q4-2026', [t, month({}), month({})]);
    expect(r.byMonth[0]).toMatchObject({ facturadoCents: 5000, baseImponibleCents: 4132, cuotaIvaCents: 868, netCents: 5500 });
  });

  it('tipo reducido del 10 %: 110 € + 5 € de propina → 100 € de base y 10 € de cuota', () => {
    const r = vat('Q4-2026', [month({ grossCents: 11_000, tipCents: 500 }), month({}), month({})], { ...BAMBU, vatBps: 1000 });
    expect(r.venue.vatPercent).toBe(10);
    expect(r.modelo303).toMatchObject({ baseImponibleCents: 10_000, cuotaIvaCents: 1000 });
  });
});

describe('devoluciones en el mes en que se hacen', () => {
  it('cobro de febrero devuelto en marzo: febrero no cambia y marzo resta', () => {
    const r = vat('Q1-2026', [
      month({}),
      month({ paymentCount: 1, grossCents: 12_100 }),
      month({ refundCount: 1, refundedCents: 12_100 }),
    ]);
    expect(r.byMonth.map((m) => [m.month, m.baseImponibleCents, m.cuotaIvaCents, m.netCents])).toEqual([
      ['2026-01', 0, 0, 0],
      ['2026-02', 10_000, 2100, 12_100],
      ['2026-03', -10_000, -2100, -12_100],
    ]);
    expect(r.modelo303).toMatchObject({ baseImponibleCents: 0, cuotaIvaCents: 0 });
  });

  it('trimestre con solo la devolución de un cobro del anterior: 303 negativo (a compensar)', () => {
    const r = vat('Q2-2026', [month({ refundCount: 1, refundedCents: 6050 }), month({}), month({})]);
    expect(r.modelo303).toEqual({ baseImponibleCents: -5000, cuotaIvaCents: -1050, totalFacturadoCents: -6050, ivaAIngresarCents: -1050 });
  });

  it('el SQL de totales pone la devolución en la ventana por su día en el banco, no por el del cobro', async () => {
    const queries: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(Prisma.sql(strings, ...values));
        return [{ ...EMPTY_TOTALS, grossCents: 15_000n, tipCents: 2000n, refundedCents: 5500n, refundedTipCents: 500n }];
      }),
      // wallet_cash_topups tiene FORCE RLS: la consulta va con el local en la sesión.
      withTenant: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const marzo = madridQuarter('Q1-2026').months[2]!;
    const t = await new PeriodReportsService(prisma as never).totals(TENANT, marzo);
    expect(t).toMatchObject({ grossCents: 15_000, tipCents: 2000, refundedCents: 5500, refundedTipCents: 500 });

    const sql = render(queries[0]!);
    const devoluciones = sql.slice(sql.indexOf('devoluciones AS ('), sql.indexOf('saldo AS ('));
    const refundAt = 'COALESCE(r."bankRefundedAt", r."createdAt")';
    expect(devoluciones).toContain(
      `${refundAt} >= <2026-02-28T23:00:00.000Z> AND ${refundAt} < <2026-03-31T22:00:00.000Z>`,
    );
    expect(devoluciones).not.toContain('authorizedAt');
    // Propina devuelta = devuelto × propina / (importe + propina), redondeada.
    expect(devoluciones).toContain(
      'ROUND(r."amountCents"::numeric * p."tipCents" / NULLIF(p."amountCents" + p."tipCents", 0))',
    );
    expect(sql).toContain('COALESCE(SUM(p."amountCents"), 0)::bigint AS "grossCents"');
    expect(sql).toContain('COALESCE(SUM(p."tipCents"), 0)::bigint AS "tipCents"');
    for (const filter of ['p."tenantId" = <local>::uuid', 'r."tenantId" = <local>::uuid', 'wp."tenantId" = <local>::uuid']) {
      expect(sql).toContain(filter);
    }
  });
});

describe('redondeo al céntimo', () => {
  it('medio céntimo exacto (13 cts al 4 % = 12,5 de base): mismo redondeo en positivo y negativo', () => {
    expect(vatSplit(13, 400)).toEqual({ baseCents: 13, cuotaCents: 0 });
    expect(vatSplit(-13, 400)).toEqual({ baseCents: -13, cuotaCents: 0 });
  });

  it('base + cuota = facturado siempre, base a ≤ ½ céntimo del exacto y simétrica con el signo', () => {
    const fallos: string[] = [];
    for (const bps of [2100, 1000, 400]) {
      for (let cents = 1; cents <= 3000; cents++) {
        const pos = vatSplit(cents, bps);
        const neg = vatSplit(-cents, bps);
        const ok =
          pos.baseCents + pos.cuotaCents === cents &&
          Math.abs(pos.baseCents - (cents * 10_000) / (10_000 + bps)) <= 0.5 &&
          neg.baseCents + pos.baseCents === 0 &&
          neg.cuotaCents + pos.cuotaCents === 0;
        if (!ok) fallos.push(`${cents} cts al ${bps / 100} %`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it('un mes sin fila de totales cuenta como vacío', () => {
    const r = vat('Q1-2026', [month({ grossCents: 12_100 })]);
    expect(r.byMonth.map((m) => m.facturadoCents)).toEqual([12_100, 0, 0]);
    expect(r.modelo303.baseImponibleCents).toBe(10_000);
  });

  it('fila del SQL con sumas nulas o sin columna → 0', () => {
    const row = { paymentCount: 1, grossCents: 15_000n, tipCents: null } as unknown as PeriodTotalsRow;
    expect(totalsFromRow(row)).toEqual({ ...EMPTY_TOTALS, paymentCount: 1, grossCents: 15_000 });
  });
});

describe('Z del periodo: propinas aparte en las ventas por tipo', () => {
  it('cada tipo lleva su importe y sus propinas por separado; sin tipo → EXTRA; a igual importe, por nombre', () => {
    const categories: ZCategoryRow[] = [
      { source: 'CARD', category: 'VENUE_BAR', count: 2, grossCents: 6000n, tipCents: 0n },
      { source: 'CARD', category: null, count: 1, grossCents: 4000n, tipCents: 500n },
      { source: 'WALLET', category: null, count: 1, grossCents: 2000n, tipCents: 300n },
      { source: 'WALLET', category: 'CHICA_SERVICE', count: 1, grossCents: 6000n, tipCents: 1500n },
    ];
    const z = buildPeriodZ({
      window: { from: new Date('2026-10-24T06:00:00Z'), to: new Date('2026-10-25T07:00:00Z') },
      totals: month({ paymentCount: 3, grossCents: 10_000, tipCents: 500 }),
      groups: [],
      categories,
      operators: [],
      operatorPayouts: { count: 0, totalCents: 0 },
      now: NOW,
    });
    expect(z.byRevenueCategory.map((c) => [c.category, c.grossCents, c.tipCents, c.paymentCents, c.consumptionCents])).toEqual([
      ['CHICA_SERVICE', 6000, 1500, 0, 6000],
      ['EXTRA', 6000, 800, 4000, 2000],
      ['VENUE_BAR', 6000, 0, 6000, 0],
    ]);
    expect(z.chicaRevenue).toEqual({ count: 1, grossCents: 6000 });
    expect(z.venueRevenue).toEqual({ count: 4, grossCents: 12_000 });
    expect(z.period).toEqual({ from: '2026-10-24T06:00:00.000Z', to: '2026-10-25T07:00:00.000Z' });
  });
});

/** Texto de la consulta con los parámetros en su sitio (fechas en ISO, el local como <local>). */
function render(q: Prisma.Sql): string {
  const label = (v: unknown): string =>
    v instanceof Date ? `<${v.toISOString()}>` : v === TENANT ? '<local>' : `<${String(v)}>`;
  return q.text.replace(/\$(\d+)/g, (_, i: string) => label(q.values[Number(i) - 1])).replace(/\s+/g, ' ');
}
