/** Días que una comisión queda "en espera" antes de poder pagarse (devoluciones tempranas). */
export const DEFAULT_PAYOUT_HOLD_DAYS = 7;

export interface EarningNet {
  commissionCents: number;
  tipCents: number | null;
  reversedCents: number;
}

/** Lo que la chica tiene a cobrar por un earning: comisión + propina − devuelto. */
export function earningNetCents(e: EarningNet): number {
  return e.commissionCents + (e.tipCents ?? 0) - e.reversedCents;
}

/**
 * Importe de un pago a la chica: earnings ya liberados menos la deuda por
 * devoluciones que llegaron cuando la comisión ya se le había pagado.
 */
export function payoutTotalCents(
  earnings: ReadonlyArray<EarningNet>,
  debts: ReadonlyArray<{ reversedDeltaCents: number }>,
): number {
  const earned = earnings.reduce((sum, e) => sum + earningNetCents(e), 0);
  const debt = debts.reduce((sum, d) => sum + d.reversedDeltaCents, 0);
  return earned - debt;
}

/** Fecha límite: los earnings creados antes (o en) este instante ya se pueden pagar. */
export function payoutCutoff(now: Date, holdDays: number): Date {
  return new Date(now.getTime() - holdDays * 24 * 3600 * 1000);
}

export function parseHoldDays(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_PAYOUT_HOLD_DAYS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PAYOUT_HOLD_DAYS;
}
