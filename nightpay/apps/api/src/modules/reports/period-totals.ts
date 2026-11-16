import { withServiceFee } from '@nightpay/contracts';

/**
 * Totales de un periodo: lo mismo para las métricas del panel, el Z del
 * periodo y el IVA 303 (reglas en reporting-sql.ts). Funciones puras.
 */
export interface PeriodTotals {
  /** Cobros pagados (incluye las recargas de saldo). */
  paymentCount: number;
  /** …de ellos, pagados con bitcoin (no pasan por el banco). Solo si los hubo. */
  bitcoinCount?: number;
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
  /**
   * Recargas del saldo en efectivo (recepción): dinero cobrado al cargarlo,
   * como la recarga con tarjeta (que ya está en grossCents). No es un cobro del
   * banco: va aparte de paymentCount.
   */
  walletCashTopUpCount: number;
  walletCashTopUpCents: number;
  /** Informativo: ya está en las devoluciones (son devoluciones de las recargas). */
  walletCardPayoutCount: number;
  walletCardPayoutCents: number;
  /**
   * Recargas del saldo cobradas con tarjeta (cobros con walletId): ya están en
   * paymentCount y grossCents. Aparte, para decir qué parte de lo cobrado no
   * es venta (chargedParts).
   */
  walletCardTopUpCount: number;
  walletCardTopUpCents: number;
  /**
   * «Comisión del servicio» (service-fee.ts) de los cobros pagados con tarjeta
   * o datáfono (pagos directos y recargas): la pagó el cliente encima y se
   * debe a OxioPay. Aparte de grossCents. Sin ninguna en el periodo, no
   * vienen (los totales, como antes de existir).
   */
  serviceFeeCents?: number;
  /** La de las recargas en efectivo (con sus anulaciones, en negativo): entra en la caja. */
  walletCashTopUpFeeCents?: number;
  /** Parte de lo devuelto que era comisión del servicio (refunds.serviceFeeCents): deja de ser de OxioPay. */
  refundedServiceFeeCents?: number;
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
  walletCashTopUpCount: 0,
  walletCashTopUpCents: 0,
  walletCardPayoutCount: 0,
  walletCardPayoutCents: 0,
  walletCardTopUpCount: 0,
  walletCardTopUpCents: 0,
};

export function totalsFromRow(row: PeriodTotalsRow | undefined): PeriodTotals {
  if (!row) return EMPTY_TOTALS;
  const keys = Object.keys(EMPTY_TOTALS) as Array<keyof PeriodTotals>;
  const n = (k: keyof PeriodTotals): number => Number(row[k] ?? 0);
  const base = Object.fromEntries(keys.map((k) => [k, n(k)])) as unknown as PeriodTotals;
  return {
    ...base,
    ...(n('bitcoinCount') > 0 ? { bitcoinCount: n('bitcoinCount') } : {}),
    ...withServiceFee({
      serviceFeeCents: n('serviceFeeCents'),
      walletCashTopUpFeeCents: n('walletCashTopUpFeeCents'),
      refundedServiceFeeCents: n('refundedServiceFeeCents'),
    }),
  };
}

/** La «Comisión del servicio» cobrada en el periodo: con tarjeta o datáfono y en efectivo (recargas). */
export function serviceFeeCollectedCents(t: PeriodTotals): number {
  return (t.serviceFeeCents ?? 0) + (t.walletCashTopUpFeeCents ?? 0);
}

/** Lo que se debe a OxioPay del periodo: la comisión del servicio cobrada − la devuelta. */
export function serviceFeeOwedCents(t: PeriodTotals): number {
  return serviceFeeCollectedCents(t) - (t.refundedServiceFeeCents ?? 0);
}

/** Lo que pagaron los clientes: importe + propinas + recargas en efectivo + la comisión del servicio. */
export function chargedCents(t: PeriodTotals): number {
  return t.grossCents + t.tipCents + t.walletCashTopUpCents + serviceFeeCollectedCents(t);
}

/**
 * Lo cobrado por partes, para que cada una diga lo que suma: ventas con
 * tarjeta (sin propinas ni recargas), propinas y recargas del saldo (con
 * tarjeta y en efectivo: no son venta). Suman chargedCents.
 */
export function chargedParts(t: PeriodTotals): { salesCents: number; tipCents: number; topUpCents: number; serviceFeeCents?: number } {
  return {
    salesCents: t.grossCents - t.walletCardTopUpCents,
    tipCents: t.tipCents,
    topUpCents: t.walletCardTopUpCents + t.walletCashTopUpCents,
    ...withServiceFee({ serviceFeeCents: serviceFeeCollectedCents(t) }),
  };
}

/** Neto: cobrado − devoluciones − saldo devuelto en efectivo. */
export function netCents(t: PeriodTotals): number {
  return chargedCents(t) - t.refundedCents - t.walletCashPayoutCents;
}

/**
 * Lo facturado (base del IVA + IVA): sin propinas, ni lo devuelto de importe,
 * ni el saldo devuelto en efectivo (la recarga ya se contó al cobrarla). La
 * recarga en efectivo cuenta igual que la de tarjeta: el IVA va con la
 * recarga y los consumos del saldo no se facturan otra vez. Sin la «Comisión
 * del servicio» (es de OxioPay: ni la cobrada ni la devuelta).
 */
export function invoicedCents(t: PeriodTotals): number {
  const refundedAmount = t.refundedCents - t.refundedTipCents - (t.refundedServiceFeeCents ?? 0);
  return t.grossCents + t.walletCashTopUpCents - refundedAmount - t.walletCashPayoutCents;
}
