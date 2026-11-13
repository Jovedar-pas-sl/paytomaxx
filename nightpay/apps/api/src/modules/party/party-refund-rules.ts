import {
  PARTY_REFUND_ERRORS,
  isRefundWindowOpen,
  type PartyRefundAskDto,
  type PartyRefundMethod,
} from '@nightpay/contracts';

/**
 * «Lo que sobra» (OxioParty): las reglas, sin base de datos.
 *
 *  - El plazo: venues.refundDeadline (último día, hora de Madrid); pasado, no se pide.
 *  - Por vía, lo que se puede pedir ahora:
 *      CARD      solo lo cargado con tarjeta que sigue en el saldo (lo gastado
 *                cuenta antes como dinero de la tarjeta, como en OxioPay:
 *                wallet-cash-limits.ts), menos lo ya pedido a la tarjeta;
 *      TRANSFER  lo cargado en efectivo que sigue en el saldo, menos lo ya pedido;
 *      DONATE    todo lo que queda sin pedir, solo si el local deja donar.
 *  - Mientras hay una pendiente, el saldo está bloqueado (blockedAt con el
 *    motivo de OxioParty): ni se gasta ni se recarga. Lo pedido sigue en el
 *    saldo hasta que el organizador la hace (y entonces sale).
 */

/** El motivo del bloqueo del saldo mientras hay una devolución pendiente. */
export const PARTY_REFUND_BLOCK_REASON = 'OxioParty: devolución pedida';

export type ByMethod = Record<PartyRefundMethod, number>;

export const ZERO_BY_METHOD: Readonly<ByMethod> = Object.freeze({ CARD: 0, TRANSFER: 0, DONATE: 0 });

export interface RefundMoney {
  /** El saldo ahora (lo pedido y pendiente sigue dentro). */
  balanceCents: number;
  /**
   * El efectivo que entró y no ha salido: recargas en efectivo − devoluciones
   * en efectivo de OxioPay − transferencias de OxioParty ya hechas.
   */
  cashLeftCents: number;
  /** Lo pedido y pendiente, por vía. */
  pending: ByMethod;
}

/** Lo que se puede pedir ahora por cada vía (0: por esa vía, nada). */
export function refundAvailability(money: RefundMoney, allowDonation: boolean): ByMethod {
  const balance = Math.max(0, money.balanceCents);
  const pendingTotal = money.pending.CARD + money.pending.TRANSFER + money.pending.DONATE;
  const remaining = Math.max(0, balance - pendingTotal);
  const cash = Math.min(balance, Math.max(0, money.cashLeftCents));
  const card = balance - cash;
  return {
    CARD: Math.max(0, Math.min(remaining, card - money.pending.CARD)),
    TRANSFER: Math.max(0, Math.min(remaining, cash - money.pending.TRANSFER)),
    DONATE: allowDonation ? remaining : 0,
  };
}

export interface RefundWallet {
  status: string;
  balanceCents: number;
  blockedAt: Date | null;
  blockedReason: string | null;
  mergedIntoId: string | null;
}

/** ¿Lo bloqueó OxioParty por una devolución (y no el super-admin por otra cosa)? */
export function blockedByRefund(wallet: Pick<RefundWallet, 'blockedAt' | 'blockedReason'>): boolean {
  return wallet.blockedAt !== null && wallet.blockedReason === PARTY_REFUND_BLOCK_REASON;
}

export type RefundAskPlan =
  | { ok: true; amountCents: number; doneNow: boolean }
  | { ok: false; code: string; message: string };

const fail = (code: string, message: string): RefundAskPlan => ({ ok: false, code, message });

/**
 * ¿Se puede pedir esto ahora? Con el saldo ya bloqueado (FOR UPDATE): el
 * importe es lo que hay ahora por esa vía. DONATE se hace al momento.
 */
export function planRefundAsk(input: {
  wallet: RefundWallet;
  deadline: string | null;
  allowDonation: boolean;
  money: RefundMoney;
  dto: Pick<PartyRefundAskDto, 'method' | 'expectedAmountCents'>;
  now: Date;
}): RefundAskPlan {
  const { wallet, dto } = input;
  if (!isRefundWindowOpen(input.deadline, input.now)) {
    return fail(PARTY_REFUND_ERRORS.closed, 'El plazo para pedir lo que sobra ya terminó.');
  }
  if (wallet.mergedIntoId || wallet.status !== 'ACTIVE') {
    return fail(PARTY_REFUND_ERRORS.nothing, 'Esta pulsera ya no tiene saldo que devolver.');
  }
  if (wallet.blockedAt && !blockedByRefund(wallet)) {
    return fail(PARTY_REFUND_ERRORS.blocked, 'Este saldo está bloqueado: pásate por la taquilla.');
  }
  if (dto.method === 'DONATE' && !input.allowDonation) {
    return fail(PARTY_REFUND_ERRORS.donation, 'En esta fiesta no se puede donar: elige otra forma.');
  }
  const available = refundAvailability(input.money, input.allowDonation);
  const amountCents = available[dto.method];
  if (amountCents <= 0) {
    const anything = available.CARD + available.TRANSFER + available.DONATE > 0;
    return anything
      ? fail(PARTY_REFUND_ERRORS.method, METHOD_UNAVAILABLE[dto.method])
      : fail(PARTY_REFUND_ERRORS.nothing, 'No te queda nada por pedir.');
  }
  if (dto.expectedAmountCents !== undefined && dto.expectedAmountCents !== amountCents) {
    return fail(PARTY_REFUND_ERRORS.changed, 'Tu saldo ha cambiado: revisa el importe y vuelve a pedirlo.');
  }
  return { ok: true, amountCents, doneNow: dto.method === 'DONATE' };
}

const METHOD_UNAVAILABLE: Readonly<Record<PartyRefundMethod, string>> = {
  CARD: 'A la tarjeta solo vuelve lo que cargaste con tarjeta: pide el resto por transferencia.',
  TRANSFER: 'Por transferencia va lo que cargaste en efectivo: lo de la tarjeta vuelve a la tarjeta.',
  DONATE: 'No te queda nada por donar.',
};

/**
 * Lo que pasa con el saldo al hacer una devolución (o al donar): baja el
 * importe; a cero y sin más pendientes, se cierra (REFUNDED). Sin más
 * pendientes, el bloqueo de OxioParty se quita (lo que quede se puede gastar).
 */
export function walletAfterRefund(
  wallet: Pick<RefundWallet, 'status' | 'balanceCents' | 'blockedAt' | 'blockedReason'>,
  amountCents: number,
  otherPending: number,
): { balanceCents: number; status?: 'REFUNDED'; unblock: boolean } | null {
  if (amountCents > wallet.balanceCents) return null;
  const balanceCents = wallet.balanceCents - amountCents;
  return {
    balanceCents,
    ...(balanceCents === 0 && otherPending === 0 && wallet.status === 'ACTIVE' ? { status: 'REFUNDED' as const } : {}),
    unblock: otherPending === 0 && blockedByRefund(wallet),
  };
}

/** Lo pendiente por vía, de las filas pendientes. */
export function pendingByMethod(rows: ReadonlyArray<{ method: string; amountCents: number; status: string }>): ByMethod {
  const out: ByMethod = { ...ZERO_BY_METHOD };
  for (const r of rows) {
    if (r.status === 'PENDING' && (r.method === 'CARD' || r.method === 'TRANSFER' || r.method === 'DONATE')) out[r.method] += r.amountCents;
  }
  return out;
}
