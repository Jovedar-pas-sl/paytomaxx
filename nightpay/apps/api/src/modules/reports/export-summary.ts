import { LEGACY_SECTION, SECTION_CODES } from '@nightpay/contracts';
import {
  WALLET_LABEL,
  categoryLabel,
  cobroSections,
  cobroStaff,
  consumoSections,
  consumoStaff,
  isChicaPart,
  partChargedCents,
  person,
  refundStaff,
  type CobroRow,
  type ConsumoRow,
  type DevolucionRow,
  type LiquidacionRow,
  type PagoSaldoRow,
  type RecargaEfectivoRow,
  type SectionLabeler,
  type StaffPart,
} from './export-rows';

/** Las recargas en efectivo, por tipo de cobro (junto a la «Recarga con tarjeta»). */
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
  /**
   * Recargas del saldo con tarjeta: ya están en `count` y `grossCents`; aparte,
   * para decir qué parte de lo cobrado no es venta. Los Z congelados antes del
   * 23-oct-2026 no lo traen.
   */
  walletCardTopUpsCount?: number;
  walletCardTopUpsCents?: number;
  byType: TypeLine[];
  chicaCommissionCents: number;
  chicaTipsCents: number;
  chicaReversalsCents: number;
  chicaNetCents: number;
  /**
   * La parte de los camareros: solo de las copas con invitación, si el local
   * se la da (de fábrica, nada). Los Z congelados antes del 2026-10-28 no lo
   * traen (y su «para el local» la incluía).
   */
  camareroCommissionCents?: number;
  camareroReversalsCents?: number;
  camareroNetCents?: number;
  venueTipsCents: number;
  /** Neto − lo de las chicas − lo de los camareros. */
  venueNetCents: number;
  /** Pagado a las chicas en el periodo. */
  payoutsCount: number;
  payoutsCents: number;
  /** Pagado a los camareros (su parte de las invitaciones). Los Z de antes del 2026-10-28 no lo traen. */
  camareroPayoutsCount?: number;
  camareroPayoutsCents?: number;
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

/**
 * Las líneas «por tipo» se suman por código de sección, no por su nombre: dos
 * secciones con el mismo nombre no se juntan, ni una sección llamada como una
 * recarga con las recargas. Esta es la clave de las recargas con tarjeta (no
 * es ningún código de sección).
 */
const CARD_TOP_UP_KEY = '#recarga-con-tarjeta';

/** El orden: el de las secciones, «Otros» de los de antes y las recargas con tarjeta. */
const KEY_ORDER: readonly string[] = [...SECTION_CODES, LEGACY_SECTION, CARD_TOP_UP_KEY];

export interface SummarizeOptions {
  /**
   * El nombre de cada sección: el del local (venueSectionLabeler), como en el
   * resto del panel. Sin él, los nombres de contabilidad de antes (categoryLabel).
   */
  labelOf?: SectionLabeler;
}

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
  opts: SummarizeOptions = {},
): ExportSummary {
  const sectionLabel = opts.labelOf ?? categoryLabel;
  const labelOfKey = (key: string) => (key === CARD_TOP_UP_KEY ? WALLET_LABEL : sectionLabel(key));
  const grossCents = sum(cobros, (r) => r.amountCents);
  const tipsCents = sum(cobros, (r) => r.tipCents);
  const refundsCents = sum(devoluciones, (r) => r.amountCents);
  const cashTopUpsCents = sum(recargasEfectivo, (r) => r.amountCents);
  const cashTopUpsN = cashTopUpsCount(recargasEfectivo);
  const cardTopUps = cobros.filter((r) => r.walletId);
  const saldo = saldoTotals(consumos, pagosSaldo);
  const { cardTipsCents, ...staff } = staffTotals(cobros, devoluciones, consumos);
  const chargedCents = grossCents + tipsCents + cashTopUpsCents;
  const netCents = chargedCents - refundsCents - saldo.walletCashPayoutsCents;
  const chicaPayouts = liquidaciones.filter((l) => !isWaiterPayout(l));
  const camareroPayouts = liquidaciones.filter(isWaiterPayout);
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
    walletCardTopUpsCount: cardTopUps.length,
    walletCardTopUpsCents: sum(cardTopUps, (r) => r.amountCents),
    byType: [
      ...typeLines(cobros, cobroParts, labelOfKey),
      ...(recargasEfectivo.length > 0
        ? [{ label: CASH_TOP_UP_LABEL, count: cashTopUpsN, chargedCents: cashTopUpsCents }]
        : []),
    ],
    ...staff,
    // Propinas con tarjeta que se queda el local (las del saldo no entran aquí).
    venueTipsCents: tipsCents - cardTipsCents,
    venueNetCents: netCents - staff.chicaNetCents - staff.camareroNetCents,
    payoutsCount: chicaPayouts.length,
    payoutsCents: sum(chicaPayouts, (r) => r.totalCents),
    camareroPayoutsCount: camareroPayouts.length,
    camareroPayoutsCents: sum(camareroPayouts, (r) => r.totalCents),
    perChica: perChica(cobros, devoluciones, chicaPayouts, consumos),
    ...saldo,
    saldoByType: typeLines(consumos, consumoParts, labelOfKey),
  };
}

/** Un pago a un camarero (su parte de las copas con invitación); el resto, a chicas. */
function isWaiterPayout(l: Pick<LiquidacionRow, 'role'>): boolean {
  return l.role === 'WAITER';
}

/**
 * La parte del personal: de los cobros con tarjeta y de lo que se cobró del
 * saldo del cliente (ese dinero entró con la recarga, ya contada). Cada
 * persona con lo suyo: la chica que cobró, la invitada a una copa y, si el
 * local se la da, el camarero que la cobró. Lo descontado, por la fecha de
 * cada devolución.
 */
function staffTotals(
  cobros: ReadonlyArray<CobroRow>,
  devoluciones: ReadonlyArray<DevolucionRow>,
  consumos: ReadonlyArray<ConsumoRow>,
) {
  const cardParts = cobros.flatMap(cobroStaff);
  const saldoParts = consumos.flatMap(consumoStaff);
  const refundParts = devoluciones.flatMap(refundStaff);
  const chicas = (xs: ReadonlyArray<StaffPart>) => xs.filter(isChicaPart);
  const camareros = (xs: ReadonlyArray<StaffPart>) => xs.filter((p) => !isChicaPart(p));
  const cardTipsCents = sum(cardParts, (p) => p.tipCents);
  const chicaCommissionCents = sum(chicas([...cardParts, ...saldoParts]), (p) => p.commissionCents);
  const chicaTipsCents = sum(chicas([...cardParts, ...saldoParts]), (p) => p.tipCents);
  const chicaReversalsCents = sum(refundParts.filter(isChicaPart), (p) => p.reversedDeltaCents);
  const camareroCommissionCents = sum(camareros([...cardParts, ...saldoParts]), (p) => p.commissionCents + p.tipCents);
  const camareroReversalsCents = sum(refundParts.filter((p) => !isChicaPart(p)), (p) => p.reversedDeltaCents);
  return {
    // Las propinas con tarjeta que no son del local (las de quien tenga parte en el cobro).
    cardTipsCents,
    chicaCommissionCents,
    chicaTipsCents,
    chicaReversalsCents,
    chicaNetCents: chicaCommissionCents + chicaTipsCents - chicaReversalsCents,
    camareroCommissionCents,
    camareroReversalsCents,
    camareroNetCents: camareroCommissionCents - camareroReversalsCents,
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
  };
}

/**
 * Lo de un cobro por tipo (por código de sección): cada sección con lo suyo
 * (por líneas, desde el 24-oct-2026) y la propina en su sección principal; las
 * recargas, aparte. Un cobro de una sola sección cuenta igual que antes.
 */
function cobroParts(r: CobroRow): Map<string, number> {
  if (r.walletId) return new Map([[CARD_TOP_UP_KEY, r.amountCents + r.tipCents]]);
  return withTip(cobroSections(r), r.revenueCategory, r.tipCents);
}

/** Lo de un consumo del saldo por tipo (como cobroParts). */
function consumoParts(r: ConsumoRow): Map<string, number> {
  return withTip(consumoSections(r), r.category, r.tipCents);
}

/** Lo de cada sección (por código), con la propina en la principal. */
function withTip(sections: Map<string, number>, main: string, tipCents: number): Map<string, number> {
  const out = new Map(sections);
  if (tipCents !== 0) out.set(main, (out.get(main) ?? 0) + tipCents);
  return out;
}

/**
 * Número e importe por tipo, sumados por clave (código de sección o recarga)
 * y nombrados con `labelOf`: en el orden de KEY_ORDER (los que no estén,
 * detrás) y sin los tipos vacíos. Un cobro con varias secciones cuenta en cada una.
 */
function typeLines<T>(rows: ReadonlyArray<T>, partsOf: (r: T) => Map<string, number>, labelOf: (key: string) => string): TypeLine[] {
  const totals = new Map<string, { count: number; chargedCents: number }>();
  for (const r of rows) {
    for (const [key, cents] of partsOf(r)) {
      const cur = totals.get(key) ?? { count: 0, chargedCents: 0 };
      totals.set(key, { count: cur.count + 1, chargedCents: cur.chargedCents + cents });
    }
  }
  const keys = [...KEY_ORDER.filter((k) => totals.has(k)), ...[...totals.keys()].filter((k) => !KEY_ORDER.includes(k))];
  return keys.flatMap((key) => {
    const t = totals.get(key);
    return t && t.count > 0 ? [{ label: labelOf(key), ...t }] : [];
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
  // Por cada chica con parte en el cobro (la que lo cobró y la invitada a una
  // copa); en una copa con invitación, lo vendido a su nombre son sus copas.
  const add = (sale: { amountCents: number; tipCents: number }, parts: ReadonlyArray<StaffPart>) => {
    for (const p of parts) {
      if (!isChicaPart(p) || !p.email) continue;
      const e = entry(p.email, person(p.name, p.email));
      e.count += 1;
      e.chargedCents += partChargedCents(p, sale);
      e.commissionCents += p.commissionCents;
      e.tipsCents += p.tipCents;
    }
  };
  for (const r of cobros) add(r, cobroStaff(r));
  for (const r of consumos) add(r, consumoStaff(r));
  for (const r of devoluciones) {
    for (const p of refundStaff(r)) {
      if (!isChicaPart(p) || !p.reversedDeltaCents || !p.email) continue;
      entry(p.email, person(p.name, p.email)).reversalsCents += p.reversedDeltaCents;
    }
  }
  for (const r of liquidaciones) {
    entry(r.operatorEmail, person(r.operatorName, r.operatorEmail)).paidCents += r.totalCents;
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, netCents: c.commissionCents + c.tipsCents - c.reversalsCents }))
    .sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name, 'es'));
}
