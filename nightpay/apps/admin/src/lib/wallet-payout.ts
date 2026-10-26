// «Devolver saldo»: lo que se dice antes de confirmar y al apuntarlo (lógica
// pura, probada en wallet-payout.test.ts). Las cifras son las que hará el API
// (GET …/payout-preview), no el saldo entero: en efectivo solo sale lo que
// entró en efectivo (y sin llegar a 1.000 € en 24 h); a la tarjeta, el resto.

import { formatEur } from './money';

export type WalletPayoutMethod = 'CASH' | 'CARD';

export interface WalletPayoutResult {
  refundedCents: number;
  method: WalletPayoutMethod;
  /** Lo que sigue en el saldo: en efectivo solo sale lo que entró en efectivo (y sin llegar a 1.000 € en 24 h). */
  remainingCents?: number;
}

/** Lo que haría el API ahora mismo por cada camino. */
export interface WalletPayoutPreview {
  balanceCents: number;
  /** En efectivo, ahora. */
  cashOutCents: number;
  /** A la tarjeta (el dueño, en el banco). */
  cardRefundCents: number;
  /** Efectivo que hoy no puede salir por el tope de 24 h (sale mañana, en efectivo). */
  cashLaterCents: number;
  /** Una devolución a la tarjeta que quedó a medias (null si no hay). */
  pendingCardCents: number | null;
}

export interface PayoutPlan {
  /** Lo que se devuelve por este camino (0 = nada: sin botón). */
  amountCents: number;
  /** Qué hacer; null si por aquí no sale nada (ver blocked). */
  instruction: string | null;
  /** Lo que queda en el saldo y por qué; null si queda cerrado. */
  remainder: string | null;
  /** Por qué no sale nada por este camino; null si sale algo. */
  blocked: string | null;
  /** Lo que queda en el saldo después. */
  leftCents: number;
}

const EMPTY = 'Este saldo no tiene nada que devolver.';
const TO_CARD = 'los devuelve el dueño en el banco («A su tarjeta»)';
const CASH_LIMIT = 'lo devuelto en efectivo no llega a 1.000 € en 24 h';

export function payoutPlan(p: WalletPayoutPreview, method: WalletPayoutMethod): PayoutPlan {
  return method === 'CASH' ? cashPlan(p) : cardPlan(p);
}

function cashPlan(p: WalletPayoutPreview): PayoutPlan {
  const cash = p.cashOutCents;
  const leftCents = Math.max(0, p.balanceCents - cash);
  if (cash <= 0) return { amountCents: 0, instruction: null, remainder: null, blocked: cashBlocked(p), leftCents };
  const closes = leftCents === 0;
  const reasons = [
    p.cardRefundCents > 0 ? `Los ${formatEur(p.cardRefundCents)} que entraron con tarjeta van a su tarjeta: ${TO_CARD}.` : null,
    p.cashLaterCents > 0
      ? `Otros ${formatEur(p.cashLaterCents)} en efectivo no pueden salir hoy (${CASH_LIMIT}): se le devuelven mañana.`
      : null,
  ].filter(Boolean);
  return {
    amountCents: cash,
    instruction: `Confirma y dale ${formatEur(cash)} en efectivo al cliente.${closes ? ' El saldo queda cerrado.' : ''}`,
    remainder: closes ? null : [`El saldo no se cierra: quedan ${formatEur(leftCents)}.`, ...reasons].join(' '),
    blocked: null,
    leftCents,
  };
}

function cashBlocked(p: WalletPayoutPreview): string {
  if (p.pendingCardCents !== null) {
    return `Hay una devolución a la tarjeta de ${formatEur(p.pendingCardCents)} a medias: que el dueño vuelva a pulsar «A su tarjeta» para terminarla. Hasta entonces, en efectivo no se devuelve nada.`;
  }
  if (p.balanceCents <= 0) return EMPTY;
  if (p.cashLaterCents > 0) {
    const card = p.cardRefundCents > 0 ? ` Los ${formatEur(p.cardRefundCents)} que entraron con tarjeta, ${TO_CARD}.` : '';
    return `Hoy no se puede devolver más en efectivo a este saldo (${CASH_LIMIT}): los ${formatEur(p.cashLaterCents)} se le devuelven mañana.${card}`;
  }
  return `Este saldo entró con tarjeta: en efectivo no se devuelve nada. Lo devuelve el dueño en el banco («A su tarjeta»).`;
}

function cardPlan(p: WalletPayoutPreview): PayoutPlan {
  const card = p.cardRefundCents;
  if (p.pendingCardCents !== null) {
    // El saldo ya no cuenta la que quedó a medias: lo que hay sigue después.
    return {
      amountCents: p.pendingCardCents,
      instruction: `Una devolución a la tarjeta de ${formatEur(p.pendingCardCents)} se quedó a medias. Si ya la hiciste en el portal de BBVA, pon la referencia y confirma para terminar de apuntarla.`,
      remainder: p.balanceCents > 0 ? `El saldo no se cierra: después quedan ${formatEur(p.balanceCents)}.` : null,
      blocked: null,
      leftCents: p.balanceCents,
    };
  }
  const leftCents = Math.max(0, p.balanceCents - card);
  if (card <= 0) {
    const blocked = p.balanceCents <= 0 ? EMPTY : 'Este saldo entró en efectivo: se devuelve en efectivo («Efectivo»), no a la tarjeta.';
    return { amountCents: 0, instruction: null, remainder: null, blocked, leftCents };
  }
  const closes = leftCents === 0;
  return {
    amountCents: card,
    instruction:
      `1. En el portal de BBVA, devuelve ${formatEur(card)} a las recargas de saldo del cliente (la más reciente primero). ` +
      `2. Pon la referencia de la devolución y confirma: aquí se apunta igual, repartido entre sus recargas.${closes ? ' El saldo queda cerrado.' : ''}`,
    remainder: closes
      ? null
      : `El saldo no se cierra: quedan ${formatEur(leftCents)} que entraron en efectivo. Se devuelven en efectivo («Efectivo»), no a la tarjeta.`,
    blocked: null,
    leftCents,
  };
}

/** El API iba a apuntar otra cifra (el saldo se movió): se vuelve a pedir lo que se devuelve ahora. */
export function isPayoutAmountChanged(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'PAYOUT_AMOUNT_CHANGED';
}

/**
 * Lo que se dice al apuntarlo. En efectivo manda lo que dice el API (lo que
 * queda); a la tarjeta, el API no lo dice: lo que queda sale del plan que se
 * enseñó (el API apuntó esa misma cifra: expectedAmountCents).
 */
export function payoutDoneText(res: WalletPayoutResult, plan?: PayoutPlan): string {
  const done =
    res.method === 'CASH'
      ? `Apuntado: dale ${formatEur(res.refundedCents)} en efectivo al cliente.`
      : `Apuntado: ${formatEur(res.refundedCents)} devueltos a la tarjeta.`;
  const left = res.remainingCents ?? plan?.leftCents ?? 0;
  if (left <= 0) return `${done} Saldo cerrado.`;
  const sameAsPlan = plan !== undefined && plan.leftCents === left && plan.remainder !== null;
  return `${done} ${sameAsPlan ? plan.remainder : `El saldo no se cierra: quedan ${formatEur(left)}.`}`;
}
