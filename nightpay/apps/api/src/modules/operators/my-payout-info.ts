/**
 * Lo que la chica ve de sus pagos en «Ganancias» (GET /operators/me/payout-info):
 * cuántos días espera un cobro antes de pagarse, a qué cuenta se le paga
 * (enmascarada) y las devoluciones que llegaron con el cobro ya pagado.
 */
import type { OxiocardView } from '@nightpay/contracts';
import { maskedPayoutAccount, type StoredPayoutAccount } from './payout-account';

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
  /** Su OxioCard: si la pidió y cómo va (null: OXIOCARD_ENABLED apagado). */
  oxiocard: OxiocardView | null;
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

/**
 * Su cuenta tapada como en el panel (la guardada aparte: no hace falta
 * abrirla; una antigua en claro, tapada al vuelo).
 */
export function payoutAccountView(u: StoredPayoutAccount | null): PayoutAccountView | null {
  if (!u) return null;
  const m = maskedPayoutAccount(u);
  const label = m.label?.trim() || null;
  if (!m.method && !label && !m.addressMasked) return null;
  return { method: m.method, label, masked: m.addressMasked };
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
