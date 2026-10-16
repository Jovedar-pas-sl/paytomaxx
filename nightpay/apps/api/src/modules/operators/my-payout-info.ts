/**
 * Lo que la chica ve de sus pagos en «Ganancias» (GET /operators/me/payout-info):
 * cuántos días espera un cobro antes de pagarse, a qué cuenta se le paga
 * (enmascarada) y las devoluciones que llegaron con el cobro ya pagado.
 */

/** A dónde se le paga, sin la dirección entera. */
export interface PayoutAccountView {
  method: string | null;
  /** El nombre que le puso ella («Mi Binance»). */
  label: string | null;
  /** «••••1332», «a•••@gmail.com»; null si no hay dirección (efectivo). */
  masked: string | null;
}

/** Devolución de un cobro que ya se le había pagado: se le descuenta de un pago. */
export interface MyDebtView {
  id: string;
  paymentId: string | null;
  /** Lo que se cobró (el cobro devuelto). */
  chargeCents: number;
  /** Lo que se le descuenta. */
  cents: number;
  /** Cuándo llegó la devolución. */
  at: string;
  /** Cuándo fue el cobro. */
  chargedAt: string;
  /** null: se descontará del próximo pago; si no, el pago en que ya se descontó. */
  settledPayoutId: string | null;
  settledAt: string | null;
}

export interface MyPayoutInfo {
  /** Días que espera un cobro antes de poder pagarse (0: se paga al cerrar la noche). */
  holdDays: number;
  account: PayoutAccountView | null;
  /** Las abiertas primero; luego las ya descontadas, de la más reciente a la más antigua. */
  debts: MyDebtView[];
}

export interface DebtRow {
  id: string;
  paymentId: string | null;
  chargeCents: number;
  cents: number;
  at: Date;
  chargedAt: Date;
  settledPayoutId: string | null;
  settledAt: Date | null;
}

const MASK = '••••';
const VISIBLE_TAIL = 4;

/** La dirección de cobro sin enseñarla entera: lo justo para reconocerla. */
export function maskPayoutAddress(address: string | null | undefined): string | null {
  const value = address?.trim();
  if (!value) return null;
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}•••${value.slice(at)}`;
  if (value.length <= VISIBLE_TAIL) return MASK;
  return `${MASK}${value.slice(-VISIBLE_TAIL)}`;
}

export function payoutAccountView(
  u: { payoutMethod?: string | null; payoutAddress?: string | null; payoutLabel?: string | null } | null,
): PayoutAccountView | null {
  if (!u) return null;
  const method = u.payoutMethod ?? null;
  const label = u.payoutLabel?.trim() || null;
  const masked = maskPayoutAddress(u.payoutAddress);
  if (!method && !label && !masked) return null;
  return { method, label, masked };
}

export function debtView(r: DebtRow): MyDebtView {
  return {
    id: r.id,
    paymentId: r.paymentId,
    chargeCents: Number(r.chargeCents),
    cents: Number(r.cents),
    at: r.at.toISOString(),
    chargedAt: r.chargedAt.toISOString(),
    settledPayoutId: r.settledPayoutId,
    settledAt: r.settledAt?.toISOString() ?? null,
  };
}
