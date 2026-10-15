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

/** Sumas de una chica: lo no pagado, la parte aún en espera y la deuda abierta. */
export interface BalanceSums {
  unpaidCents: number;
  heldCents: number;
  debtCents: number;
}

/**
 * Lo que entra ya en su próximo pago (como createPayout): lo no pagado menos
 * lo que sigue en espera menos la deuda por devoluciones tras un pago.
 */
export function availableCentsOf(s: BalanceSums): number {
  return s.unpaidCents - Math.max(0, s.heldCents) - s.debtCents;
}

/**
 * Tesorería: lo que hay que pagar ya a las chicas. La deuda de una no resta
 * a las demás (su disponible negativo cuenta 0); en espera y deuda, aparte.
 */
export function payableSummary(rows: ReadonlyArray<BalanceSums>): {
  payableCents: number;
  operatorCount: number;
  heldCents: number;
  debtCents: number;
} {
  const available = rows.map(availableCentsOf);
  return {
    payableCents: available.reduce((sum, a) => sum + Math.max(0, a), 0),
    operatorCount: available.filter((a) => a > 0).length,
    heldCents: rows.reduce((sum, r) => sum + Math.max(0, r.heldCents), 0),
    debtCents: rows.reduce((sum, r) => sum + r.debtCents, 0),
  };
}

/** Fecha límite: los earnings creados antes (o en) este instante ya se pueden pagar. */
export function payoutCutoff(now: Date, holdDays: number): Date {
  return new Date(now.getTime() - holdDays * 24 * 3600 * 1000);
}

export function parseHoldDays(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_PAYOUT_HOLD_DAYS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PAYOUT_HOLD_DAYS;
}

/** Tope de los días de espera por local (igual que PAYOUT_HOLD_DAYS y el CHECK de venues). */
export const MAX_PAYOUT_HOLD_DAYS = 60;

/**
 * Días de espera de un local: los suyos (venues.payoutHoldDays, 0–60; 0 = se
 * paga al cierre de la noche) o, si no tiene (null) o no valen, los del
 * entorno (PAYOUT_HOLD_DAYS).
 */
export function resolveHoldDays(venueHoldDays: number | null | undefined, envRaw: unknown): number {
  if (
    typeof venueHoldDays === 'number' &&
    Number.isInteger(venueHoldDays) &&
    venueHoldDays >= 0 &&
    venueHoldDays <= MAX_PAYOUT_HOLD_DAYS
  ) {
    return venueHoldDays;
  }
  return parseHoldDays(envRaw);
}
