/**
 * Lo que se le quita a la chica cuando se devuelve (parte de) un cobro: su
 * parte entera — comisión y propina (decisión del dueño, 2026-10-14) — en la
 * misma proporción que lo devuelto sobre lo cobrado (servicio + propina).
 *
 *   devolución total   → pierde comisión y propina
 *   devolución del 50% → pierde la mitad de cada una
 *   cobro sin propina  → igual que antes (la comisión en proporción)
 *
 * Es el total acumulado esperado tras todas las devoluciones hasta ahora; quien
 * lo usa aplica la diferencia con lo ya descontado (sin céntimos sueltos).
 */
export function expectedChicaReversal(args: {
  commissionCents: number;
  /** Propina que se llevó la chica en este cobro. */
  tipCents: number;
  /** Lo que pagó el cliente: servicio + propina. */
  chargedCents: number;
  /** Devuelto hasta ahora en este cobro (todas las devoluciones). */
  refundedCents: number;
}): number {
  if (args.chargedCents <= 0) return 0;
  const refunded = Math.min(Math.max(args.refundedCents, 0), args.chargedCents);
  return Math.round(((args.commissionCents + args.tipCents) * refunded) / args.chargedCents);
}
