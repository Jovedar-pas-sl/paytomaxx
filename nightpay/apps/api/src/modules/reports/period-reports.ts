import { chargedCents, netCents, serviceFeeCollectedCents, serviceFeeOwedCents, type PeriodTotals } from './period-totals';
import type { TimeWindow } from './report-period';

/**
 * Métricas del panel y Z de un periodo, a partir de las filas agregadas del
 * SQL (period-reports.service.ts). Funciones puras; reglas en reporting-sql.ts.
 */

type Num = number | bigint | null;

const n = (v: Num): number => Number(v ?? 0);

// ─── Métricas (hoy y semana) ────────────────────────────────────────────

export interface MetricsPeriod {
  count: number;
  /** Sin propinas (como en el Z, el IVA y la gestoría). */
  grossCents: number;
  tipCents: number;
  chargedCents: number;
  refundedCents: number;
  walletCashPayoutCents: number;
  /** Recargas en efectivo (ya en chargedCents). */
  walletCashTopUpCents: number;
  /** Recargas con tarjeta (ya en grossCents y count): grossCents − esto = ventas con tarjeta. */
  walletCardTopUpCents: number;
  /** «Comisión del servicio» cobrada (ya en chargedCents): se debe a OxioPay. */
  serviceFeeCents: number;
  /** Cobrado (con propinas, recargas en efectivo y comisión) − devoluciones − saldo devuelto en efectivo. */
  netCents: number;
}

export function metricsPeriod(t: PeriodTotals): MetricsPeriod {
  return {
    count: t.paymentCount,
    grossCents: t.grossCents,
    tipCents: t.tipCents,
    chargedCents: chargedCents(t),
    refundedCents: t.refundedCents,
    walletCashPayoutCents: t.walletCashPayoutCents,
    walletCashTopUpCents: t.walletCashTopUpCents,
    walletCardTopUpCents: t.walletCardTopUpCents,
    serviceFeeCents: serviceFeeCollectedCents(t),
    netCents: netCents(t),
  };
}

export function buildMetrics(args: {
  today: PeriodTotals;
  week: PeriodTotals;
  statuses: ReadonlyArray<{ status: string; count: Num }>;
}): { today: MetricsPeriod; week: MetricsPeriod; statusBreakdown: Record<string, number> } {
  return {
    today: metricsPeriod(args.today),
    week: metricsPeriod(args.week),
    statusBreakdown: Object.fromEntries(args.statuses.map((s) => [s.status, n(s.count)])),
  };
}

// ─── Z de un periodo ────────────────────────────────────────────────────

/** Cobros pagados agrupados por medio, pasarela y zona del terminal. */
export interface ZGroupRow {
  captureMethod: string | null;
  provider: string | null;
  zone: string | null;
  count: Num;
  grossCents: Num;
  tipCents: Num;
}

/**
 * Ventas por tipo. CARD = cobros (no recargas); TOPUP = recargas de saldo
 * (dinero que entra, no es una venta); WALLET = consumos del saldo (ventas).
 */
export interface ZCategoryRow {
  source: 'CARD' | 'TOPUP' | 'WALLET';
  category: string | null;
  count: Num;
  grossCents: Num;
  tipCents: Num;
}

/** Parte de cada chica de lo cobrado en el periodo (comisión + propina − descuentos, deuda incluida). */
export interface ZOperatorRow {
  operatorId: string;
  displayName: string | null;
  email: string;
  earningCount: Num;
  netCents: Num;
}

interface Bucket {
  count: number;
  grossCents: number;
  tipCents: number;
}

export interface CategoryLine extends Bucket {
  category: string;
  paymentCount: number;
  paymentCents: number;
  consumptionCount: number;
  consumptionCents: number;
}

const TOP_OPERATORS = 5;

export function buildPeriodZ(args: {
  window: TimeWindow;
  totals: PeriodTotals;
  groups: ReadonlyArray<ZGroupRow>;
  categories: ReadonlyArray<ZCategoryRow>;
  operators: ReadonlyArray<ZOperatorRow>;
  operatorPayouts: { count: Num; totalCents: Num };
  now: Date;
}) {
  const t = args.totals;
  const sales = salesByCategory(args.categories);
  const operators = args.operators
    .map((o) => ({ ...o, earningCount: n(o.earningCount), netCents: n(o.netCents) }))
    .sort((a, b) => b.netCents - a.netCents);
  return {
    period: { from: args.window.from.toISOString(), to: args.window.to.toISOString() },
    summary: {
      paymentCount: t.paymentCount,
      grossCents: t.grossCents,
      tipCents: t.tipCents,
      chargedCents: chargedCents(t),
      refundCount: t.refundCount,
      refundedCents: t.refundedCents,
      walletCashPayoutCount: t.walletCashPayoutCount,
      walletCashPayoutCents: t.walletCashPayoutCents,
      walletCashTopUpCount: t.walletCashTopUpCount,
      walletCashTopUpCents: t.walletCashTopUpCents,
      // «Comisión del servicio»: cobrada (ya en chargedCents), devuelta y lo que se debe a OxioPay.
      serviceFeeCents: serviceFeeCollectedCents(t),
      refundedServiceFeeCents: t.refundedServiceFeeCents ?? 0,
      serviceFeeOwedCents: serviceFeeOwedCents(t),
      netCents: netCents(t),
    },
    byCaptureMethod: groupBy(args.groups, (g) => g.captureMethod ?? 'QR').map(({ key, ...b }) => ({ method: key, ...b })),
    byProvider: groupBy(args.groups, (g) => g.provider ?? 'NONE').map(({ key, ...b }) => ({ provider: key, ...b })),
    byZone: groupBy(args.groups, (g) => g.zone ?? 'SIN_ZONA').map(({ key, ...b }) => ({ zone: key, ...b })),
    byRevenueCategory: sales,
    chicaRevenue: revenueOf(sales.filter((s) => s.category === 'CHICA_SERVICE')),
    venueRevenue: revenueOf(sales.filter((s) => s.category !== 'CHICA_SERVICE')),
    topOperators: operators.slice(0, TOP_OPERATORS).map((o) => ({
      operatorId: o.operatorId,
      displayName: o.displayName,
      email: o.email,
      netCents: o.netCents,
      earningCount: o.earningCount,
    })),
    wallet: walletSection(args.categories, t),
    earnings: {
      count: operators.reduce((a, o) => a + o.earningCount, 0),
      totalNetCents: operators.reduce((a, o) => a + o.netCents, 0),
    },
    payouts: { count: n(args.operatorPayouts.count), totalCents: n(args.operatorPayouts.totalCents) },
    generatedAt: args.now.toISOString(),
  };
}

/** Suma filas por una clave y ordena de más a menos importe. */
function groupBy<T extends { count: Num; grossCents: Num; tipCents: Num }>(
  rows: ReadonlyArray<T>,
  keyOf: (row: T) => string,
): Array<Bucket & { key: string }> {
  const sums = new Map<string, Bucket>();
  for (const r of rows) {
    const key = keyOf(r);
    const prev = sums.get(key) ?? { count: 0, grossCents: 0, tipCents: 0 };
    sums.set(key, {
      count: prev.count + n(r.count),
      grossCents: prev.grossCents + n(r.grossCents),
      tipCents: prev.tipCents + n(r.tipCents),
    });
  }
  return [...sums.entries()]
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => b.grossCents - a.grossCents || a.key.localeCompare(b.key));
}

/** Ventas por tipo: cobros con tarjeta + consumos del saldo (sin las recargas). */
function salesByCategory(rows: ReadonlyArray<ZCategoryRow>): CategoryLine[] {
  const sales = rows.filter((r) => r.source !== 'TOPUP');
  return groupBy(sales, (r) => r.category ?? 'EXTRA').map(({ key, ...b }) => {
    const of = (source: ZCategoryRow['source']) =>
      sales.filter((r) => r.source === source && (r.category ?? 'EXTRA') === key);
    const card = of('CARD');
    const wallet = of('WALLET');
    return {
      category: key,
      ...b,
      paymentCount: card.reduce((a, r) => a + n(r.count), 0),
      paymentCents: card.reduce((a, r) => a + n(r.grossCents), 0),
      consumptionCount: wallet.reduce((a, r) => a + n(r.count), 0),
      consumptionCents: wallet.reduce((a, r) => a + n(r.grossCents), 0),
    };
  });
}

function revenueOf(lines: ReadonlyArray<CategoryLine>): { count: number; grossCents: number } {
  return {
    count: lines.reduce((a, l) => a + l.count, 0),
    grossCents: lines.reduce((a, l) => a + l.grossCents, 0),
  };
}

function walletSection(rows: ReadonlyArray<ZCategoryRow>, t: PeriodTotals) {
  const sum = (source: ZCategoryRow['source'], k: 'count' | 'grossCents' | 'tipCents'): number =>
    rows.filter((r) => r.source === source).reduce((a, r) => a + n(r[k]), 0);
  return {
    topUpCount: sum('TOPUP', 'count'),
    topUpCents: sum('TOPUP', 'grossCents'),
    consumptionCount: sum('WALLET', 'count'),
    consumptionCents: sum('WALLET', 'grossCents'),
    consumptionTipCents: sum('WALLET', 'tipCents'),
    cashTopUpCount: t.walletCashTopUpCount,
    cashTopUpCents: t.walletCashTopUpCents,
    cashPayoutCount: t.walletCashPayoutCount,
    cashPayoutCents: t.walletCashPayoutCents,
    cardPayoutCount: t.walletCardPayoutCount,
    cardPayoutCents: t.walletCardPayoutCents,
  };
}
