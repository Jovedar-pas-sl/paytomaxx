import {
  CATEGORY_LABEL,
  WALLET_LABEL,
  categoryLabel,
  cobroSections,
  consumoSections,
  person,
  type CobroRow,
  type ConsumoRow,
  type DevolucionRow,
  type LiquidacionRow,
  type PagoSaldoRow,
  type RecargaEfectivoRow,
} from './export-rows';

/** Las recargas en efectivo, por tipo de cobro (junto a la «Recarga de wallet» con tarjeta). */
export const CASH_TOP_UP_LABEL = 'Recarga en efectivo';

/**
 * Resumen de un periodo: el CSV «resumen» de la gestoría, el Z de la noche y
 * el aviso de la mañana. Mismas reglas que el resto de informes
 * (reporting-sql.ts). Funciones puras: reciben filas, devuelven totales.
 */

export interface ChicaSummary {
  name: string;
  count: number;
  chargedCents: number;
  commissionCents: number;
  tipsCents: number;
  reversalsCents: number;
  netCents: number;
  paidCents: number;
}

export interface TypeLine {
  label: string;
  count: number;
  chargedCents: number;
}

export interface ExportSummary {
  count: number;
  grossCents: number;
  tipsCents: number;
  /** Lo que pagaron los clientes: cobros + propinas + recargas en efectivo. */
  chargedCents: number;
  refundsCount: number;
  refundsCents: number;
  /** Cobrado − devoluciones − saldo devuelto en efectivo. */
  netCents: number;
  /**
   * Recargas del saldo en efectivo (recepción): cobradas al cargarlas, como
   * las de tarjeta (no son cobros del banco: van aparte de `count`). Los Z
   * congelados antes del 21-oct-2026 no lo traen.
   */
  walletCashTopUpsCount?: number;
  walletCashTopUpsCents?: number;
  byType: TypeLine[];
  chicaCommissionCents: number;
  chicaTipsCents: number;
  chicaReversalsCents: number;
  chicaNetCents: number;
  venueTipsCents: number;
  venueNetCents: number;
  payoutsCount: number;
  payoutsCents: number;
  perChica: ChicaSummary[];
  /** Saldo devuelto al cliente en efectivo: resta del neto. */
  walletCashPayoutsCount: number;
  walletCashPayoutsCents: number;
  /** Saldo devuelto a la tarjeta: ya está en las devoluciones (solo se informa). */
  walletCardPayoutsCount: number;
  walletCardPayoutsCents: number;
  /** Consumos del saldo (importe + propina): ventas, no dinero nuevo. */
  consumptionsCount: number;
  consumptionsCents: number;
  saldoByType: TypeLine[];
}

const TYPE_ORDER = [...Object.values(CATEGORY_LABEL), WALLET_LABEL];

function sum<T>(xs: ReadonlyArray<T>, f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}

/** Recargas en efectivo: cada anulación (fila negativa) resta una. */
export function cashTopUpsCount(rows: ReadonlyArray<Pick<RecargaEfectivoRow, 'amountCents'>>): number {
  return sum(rows, (r) => (r.amountCents < 0 ? -1 : 1));
}

/**
 * Totales del periodo. Cobros por fecha de cobro; devoluciones, pagos a
 * chicas y saldo devuelto por su propia fecha (una devolución de octubre de
 * un cobro de septiembre cuenta en octubre, como en el banco).
 */
export function summarize(
  cobros: ReadonlyArray<CobroRow>,
  devoluciones: ReadonlyArray<DevolucionRow>,
  liquidaciones: ReadonlyArray<LiquidacionRow>,
  consumos: ReadonlyArray<ConsumoRow> = [],
  pagosSaldo: ReadonlyArray<PagoSaldoRow> = [],
  recargasEfectivo: ReadonlyArray<RecargaEfectivoRow> = [],
): ExportSummary {
  const grossCents = sum(cobros, (r) => r.amountCents);
  const tipsCents = sum(cobros, (r) => r.tipCents);
  const refundsCents = sum(devoluciones, (r) => r.amountCents);
  const cashTopUpsCents = sum(recargasEfectivo, (r) => r.amountCents);
  const cashTopUpsN = cashTopUpsCount(recargasEfectivo);
  const saldo = saldoTotals(consumos, pagosSaldo);
  const { cardTipsCents, ...chica } = chicaTotals(cobros, devoluciones, consumos);
  const chargedCents = grossCents + tipsCents + cashTopUpsCents;
  const netCents = chargedCents - refundsCents - saldo.walletCashPayoutsCents;
  return {
    count: cobros.length,
    grossCents,
    tipsCents,
    chargedCents,
    refundsCount: devoluciones.length,
    refundsCents,
    netCents,
    walletCashTopUpsCount: cashTopUpsN,
    walletCashTopUpsCents: cashTopUpsCents,
    byType: [
      ...typeLines(cobros, TYPE_ORDER, cobroParts),
      ...(recargasEfectivo.length > 0
        ? [{ label: CASH_TOP_UP_LABEL, count: cashTopUpsN, chargedCents: cashTopUpsCents }]
        : []),
    ],
    ...chica,
    // Propinas con tarjeta que se queda el local (las del saldo no entran aquí).
    venueTipsCents: tipsCents - cardTipsCents,
    venueNetCents: netCents - chica.chicaNetCents,
    payoutsCount: liquidaciones.length,
    payoutsCents: sum(liquidaciones, (r) => r.totalCents),
    perChica: perChica(cobros, devoluciones, liquidaciones, consumos),
    ...saldo,
  };
}

/**
 * La parte de las chicas: de los cobros con tarjeta y de lo que cobraron del
 * saldo del cliente (ese dinero entró con la recarga, ya contada).
 */
function chicaTotals(
  cobros: ReadonlyArray<CobroRow>,
  devoluciones: ReadonlyArray<DevolucionRow>,
  consumos: ReadonlyArray<ConsumoRow>,
) {
  const cardTipsCents = sum(cobros, (r) => (r.commissionCents === null ? 0 : (r.earningTipCents ?? 0)));
  const chicaCommissionCents = sum(cobros, (r) => r.commissionCents ?? 0) + sum(consumos, (r) => r.commissionCents ?? 0);
  const chicaTipsCents = cardTipsCents + sum(consumos, (r) => r.earningTipCents ?? 0);
  const chicaReversalsCents = sum(devoluciones, (r) => r.reversedDeltaCents ?? 0);
  return {
    cardTipsCents,
    chicaCommissionCents,
    chicaTipsCents,
    chicaReversalsCents,
    chicaNetCents: chicaCommissionCents + chicaTipsCents - chicaReversalsCents,
  };
}

/** Lo del saldo de los clientes: lo devuelto (efectivo / tarjeta) y los consumos por tipo. */
function saldoTotals(consumos: ReadonlyArray<ConsumoRow>, pagosSaldo: ReadonlyArray<PagoSaldoRow>) {
  const cash = pagosSaldo.filter((p) => p.method === 'CASH');
  const card = pagosSaldo.filter((p) => p.method === 'CARD');
  return {
    walletCashPayoutsCount: cash.length,
    walletCashPayoutsCents: sum(cash, (p) => p.amountCents),
    walletCardPayoutsCount: card.length,
    walletCardPayoutsCents: sum(card, (p) => p.amountCents),
    consumptionsCount: consumos.length,
    consumptionsCents: sum(consumos, (r) => r.amountCents + r.tipCents),
    saldoByType: typeLines(consumos, Object.values(CATEGORY_LABEL), consumoParts),
  };
}

/**
 * Lo de un cobro por tipo: cada sección con lo suyo (por líneas, desde el
 * 24-oct-2026) y la propina en su sección principal; las recargas, aparte.
 * Un cobro de una sola sección cuenta igual que antes (importe + propina).
 */
function cobroParts(r: CobroRow): Map<string, number> {
  if (r.walletId) return new Map([[WALLET_LABEL, r.amountCents + r.tipCents]]);
  return withTip(cobroSections(r), r.revenueCategory, r.tipCents);
}

/** Lo de un consumo del saldo por tipo (como cobroParts). */
function consumoParts(r: ConsumoRow): Map<string, number> {
  return withTip(consumoSections(r), r.category, r.tipCents);
}

/** Sección → etiqueta (juntando las que comparten nombre), con la propina en la principal. */
function withTip(sections: Map<string, number>, main: string, tipCents: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const [code, cents] of sections) out.set(categoryLabel(code), (out.get(categoryLabel(code)) ?? 0) + cents);
  if (tipCents !== 0) out.set(categoryLabel(main), (out.get(categoryLabel(main)) ?? 0) + tipCents);
  return out;
}

/**
 * Número e importe por tipo: en el orden dado (los que no estén, detrás) y
 * sin los tipos vacíos. Un cobro con varias secciones cuenta en cada una.
 */
function typeLines<T>(rows: ReadonlyArray<T>, order: ReadonlyArray<string>, partsOf: (r: T) => Map<string, number>): TypeLine[] {
  const totals = new Map<string, TypeLine>();
  for (const r of rows) {
    for (const [label, cents] of partsOf(r)) {
      const cur = totals.get(label) ?? { label, count: 0, chargedCents: 0 };
      totals.set(label, { label, count: cur.count + 1, chargedCents: cur.chargedCents + cents });
    }
  }
  const labels = [...order.filter((l) => totals.has(l)), ...[...totals.keys()].filter((l) => !order.includes(l))];
  return labels.flatMap((l) => {
    const t = totals.get(l);
    return t && t.count > 0 ? [t] : [];
  });
}

function perChica(
  cobros: ReadonlyArray<CobroRow>,
  devoluciones: ReadonlyArray<DevolucionRow>,
  liquidaciones: ReadonlyArray<LiquidacionRow>,
  consumos: ReadonlyArray<ConsumoRow>,
): ChicaSummary[] {
  const byKey = new Map<string, ChicaSummary>();
  const entry = (key: string, name: string): ChicaSummary => {
    const found = byKey.get(key);
    if (found) return found;
    const fresh: ChicaSummary = {
      name, count: 0, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversalsCents: 0, netCents: 0, paidCents: 0,
    };
    byKey.set(key, fresh);
    return fresh;
  };
  // Acumuladores locales a esta función: se rellenan y se devuelven copiados.
  for (const r of cobros) {
    if (r.commissionCents === null || !r.earningOperatorEmail) continue;
    const e = entry(r.earningOperatorEmail, person(r.earningOperatorName, r.earningOperatorEmail));
    e.count += 1;
    e.chargedCents += r.amountCents + r.tipCents;
    e.commissionCents += r.commissionCents;
    e.tipsCents += r.earningTipCents ?? 0;
  }
  for (const r of consumos) {
    if (r.commissionCents === null || !r.operatorEmail) continue;
    const e = entry(r.operatorEmail, person(r.operatorName, r.operatorEmail));
    e.count += 1;
    e.chargedCents += r.amountCents + r.tipCents;
    e.commissionCents += r.commissionCents;
    e.tipsCents += r.earningTipCents ?? 0;
  }
  for (const r of devoluciones) {
    if (!r.reversedDeltaCents || !r.chicaEmail) continue;
    entry(r.chicaEmail, person(r.chicaName, r.chicaEmail)).reversalsCents += r.reversedDeltaCents;
  }
  for (const r of liquidaciones) {
    entry(r.operatorEmail, person(r.operatorName, r.operatorEmail)).paidCents += r.totalCents;
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, netCents: c.commissionCents + c.tipsCents - c.reversalsCents }))
    .sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name, 'es'));
}
