import { EMPTY_TOTALS, invoicedCents, netCents, type PeriodTotals } from './period-totals';
import type { QuarterWindow } from './reporting-window';

/**
 * Modelo 303 (IVA trimestral) a partir de los totales de cada mes de Madrid.
 * Funciones puras; las reglas de qué cuenta, en reporting-sql.ts:
 *  - Base: lo facturado SIN propinas (propinas voluntarias, como dice el
 *    resumen de la gestoría), menos lo devuelto de importe y el saldo devuelto
 *    en efectivo. El IVA de la recarga de saldo va al cobrarla.
 *  - El trimestre es la suma de sus meses (base y cuota de cada mes).
 */

export interface VatVenue {
  name: string;
  vatBps: number;
  vatRegime: string;
}

export interface VatMonthRow {
  month: string;
  grossCents: number;
  tipCents: number;
  refundedCents: number;
  /** Neto cobrado del mes (con propinas, como en el resto de informes). */
  netCents: number;
  baseImponibleCents: number;
  cuotaIvaCents: number;
  refundedTipCents: number;
  walletCashPayoutCents: number;
  walletCardPayoutCents: number;
  /** Recargas en efectivo del mes (facturadas al cargarlas, como las de tarjeta). */
  walletCashTopUpCents: number;
  /** Lo facturado del mes = base + cuota (sin propinas). */
  facturadoCents: number;
}

interface VatHead {
  quarter: string;
  from: string;
  to: string;
}

export interface VatExemptReport extends VatHead {
  venue: VatVenue;
  exento: true;
  message: string;
}

export interface Vat303Report extends VatHead {
  venue: VatVenue & { vatPercent: number };
  modelo303: { baseImponibleCents: number; cuotaIvaCents: number; totalFacturadoCents: number; ivaAIngresarCents: number };
  breakdown: {
    grossCents: number;
    tipCents: number;
    refundedCents: number;
    netCobradoCents: number;
    refundedTipCents: number;
    walletCashPayoutCents: number;
    walletCardPayoutCents: number;
    walletCashTopUpCents: number;
    facturadoCents: number;
  };
  walletInfo: { consumptionCount: number; consumptionCents: number; note: string };
  byMonth: VatMonthRow[];
  disclaimer: string;
  generatedAt: string;
}

const WALLET_NOTE =
  'Los consumos del saldo son operaciones internas: no se facturan otra vez. El IVA va con la recarga ' +
  '(con tarjeta o en efectivo), y el saldo que se devuelve al cliente (en efectivo o a la tarjeta) lo resta.';

const DISCLAIMER =
  'Reporte automático sin auditoría fiscal. Verifica con tu asesor antes de presentar Modelo 303. ' +
  'Las propinas no entran en la base (van aparte en el desglose). ' +
  'Recargo de equivalencia + facturas de gasto deducibles requieren tratamiento manual.';

/** Importe con IVA incluido → base y cuota (redondeo simétrico al céntimo). */
export function vatSplit(invoiced: number, vatBps: number): { baseCents: number; cuotaCents: number } {
  const exact = (invoiced * 10_000) / (10_000 + vatBps);
  const rounded = Math.round(Math.abs(exact));
  const baseCents = exact < 0 ? 0 - rounded : rounded;
  return { baseCents, cuotaCents: invoiced - baseCents };
}

export function vatExempt(quarter: QuarterWindow, venue: VatVenue): VatExemptReport {
  return {
    ...head(quarter),
    venue: { name: venue.name, vatBps: venue.vatBps, vatRegime: venue.vatRegime },
    exento: true,
    message: 'Venue en régimen EXENTO — no aplica Modelo 303',
  };
}

export function buildVat303(args: {
  quarter: QuarterWindow;
  venue: VatVenue;
  /** Totales de cada mes, en el orden de quarter.months. */
  months: ReadonlyArray<PeriodTotals>;
  consumptions: { count: number; cents: number };
  now: Date;
}): Vat303Report | VatExemptReport {
  const { quarter, venue } = args;
  if (venue.vatRegime === 'EXENTO') return vatExempt(quarter, venue);
  const byMonth = quarter.months.map((m, i) => vatMonth(m.month, args.months[i] ?? EMPTY_TOTALS, venue.vatBps));
  const total = (k: keyof VatMonthRow): number => byMonth.reduce((a, m) => a + (m[k] as number), 0);
  const base = total('baseImponibleCents');
  const cuota = total('cuotaIvaCents');
  return {
    ...head(quarter),
    venue: { name: venue.name, vatBps: venue.vatBps, vatPercent: venue.vatBps / 100, vatRegime: venue.vatRegime },
    modelo303: { baseImponibleCents: base, cuotaIvaCents: cuota, totalFacturadoCents: base + cuota, ivaAIngresarCents: cuota },
    breakdown: {
      grossCents: total('grossCents'),
      tipCents: total('tipCents'),
      refundedCents: total('refundedCents'),
      netCobradoCents: total('netCents'),
      refundedTipCents: total('refundedTipCents'),
      walletCashPayoutCents: total('walletCashPayoutCents'),
      walletCardPayoutCents: total('walletCardPayoutCents'),
      walletCashTopUpCents: total('walletCashTopUpCents'),
      facturadoCents: total('facturadoCents'),
    },
    walletInfo: { consumptionCount: args.consumptions.count, consumptionCents: args.consumptions.cents, note: WALLET_NOTE },
    byMonth,
    disclaimer: DISCLAIMER,
    generatedAt: args.now.toISOString(),
  };
}

function vatMonth(month: string, t: PeriodTotals, vatBps: number): VatMonthRow {
  const facturado = invoicedCents(t);
  const { baseCents, cuotaCents } = vatSplit(facturado, vatBps);
  return {
    month,
    grossCents: t.grossCents,
    tipCents: t.tipCents,
    refundedCents: t.refundedCents,
    netCents: netCents(t),
    baseImponibleCents: baseCents,
    cuotaIvaCents: cuotaCents,
    refundedTipCents: t.refundedTipCents,
    walletCashPayoutCents: t.walletCashPayoutCents,
    walletCardPayoutCents: t.walletCardPayoutCents,
    walletCashTopUpCents: t.walletCashTopUpCents,
    facturadoCents: facturado,
  };
}

function head(quarter: QuarterWindow): VatHead {
  return { quarter: quarter.label, from: quarter.from.toISOString(), to: quarter.to.toISOString() };
}
