/**
 * Totales de un periodo: lo mismo para las métricas del panel, el Z del
 * periodo y el IVA 303 (reglas en reporting-sql.ts). Funciones puras.
 */
export interface PeriodTotals {
  /** Cobros pagados (incluye las recargas de saldo). */
  paymentCount: number;
  /** Importe sin propinas. */
  grossCents: number;
  tipCents: number;
  refundCount: number;
  /** Devoluciones hechas (incluye el saldo devuelto a la tarjeta). */
  refundedCents: number;
  /** Parte de lo devuelto que era propina (en proporción a lo cobrado). */
  refundedTipCents: number;
  walletCashPayoutCount: number;
  walletCashPayoutCents: number;
  /** Informativo: ya está en las devoluciones (son devoluciones de las recargas). */
  walletCardPayoutCount: number;
  walletCardPayoutCents: number;
}

/** Fila del SQL de totales: las sumas llegan como bigint. */
export type PeriodTotalsRow = { [K in keyof PeriodTotals]: number | bigint };

export const EMPTY_TOTALS: PeriodTotals = {
  paymentCount: 0,
  grossCents: 0,
  tipCents: 0,
  refundCount: 0,
  refundedCents: 0,
  refundedTipCents: 0,
  walletCashPayoutCount: 0,
  walletCashPayoutCents: 0,
  walletCardPayoutCount: 0,
  walletCardPayoutCents: 0,
};

export function totalsFromRow(row: PeriodTotalsRow | undefined): PeriodTotals {
  if (!row) return EMPTY_TOTALS;
  const keys = Object.keys(EMPTY_TOTALS) as Array<keyof PeriodTotals>;
  return Object.fromEntries(keys.map((k) => [k, Number(row[k] ?? 0)])) as unknown as PeriodTotals;
}

/** Lo que pagaron los clientes: importe + propinas. */
export function chargedCents(t: PeriodTotals): number {
  return t.grossCents + t.tipCents;
}

/** Neto: cobrado − devoluciones − saldo devuelto en efectivo. */
export function netCents(t: PeriodTotals): number {
  return chargedCents(t) - t.refundedCents - t.walletCashPayoutCents;
}

/**
 * Lo facturado (base del IVA + IVA): sin propinas, ni lo devuelto de importe,
 * ni el saldo devuelto en efectivo (la recarga ya se contó al cobrarla).
 */
export function invoicedCents(t: PeriodTotals): number {
  return t.grossCents - (t.refundedCents - t.refundedTipCents) - t.walletCashPayoutCents;
}
