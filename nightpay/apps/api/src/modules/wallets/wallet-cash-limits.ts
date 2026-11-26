import { CASH_LIMIT_CENTS, CASH_LIMIT_WINDOW_HOURS } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { eur } from '../../common/money/eur';

/**
 * El efectivo de un saldo (y de los saldos sumados a él, mergedIntoId) y sus
 * reglas, para que el efectivo no se convierta en dinero del banco ni al revés
 * y no se trocee para saltar el tope legal (art. 7 de la Ley 7/2012):
 *  - lo que entra en efectivo en 24 h (recargas − anulaciones) no llega a 1.000 €;
 *  - en efectivo solo se devuelve lo que entró en efectivo y no ha salido, y
 *    lo devuelto en efectivo en 24 h tampoco llega a 1.000 €;
 *  - a la tarjeta, como mucho el saldo menos ese efectivo (lo gastado cuenta
 *    primero como dinero de la tarjeta) y menos lo que entró con bitcoin;
 *  - lo que entró con bitcoin NO se devuelve (decisión del dueño, 17-nov-2026):
 *    ni en efectivo ni en bitcoin; se queda como saldo para otra noche. Lo
 *    gastado cuenta primero contra el bitcoin (luego la tarjeta, y el efectivo
 *    lo último), y nunca sale por el banco más de lo que entró con tarjeta.
 * Funciones puras más una lectura. Llamar con el saldo ya bloqueado (FOR
 * UPDATE), dentro de una transacción con bypass de RLS (acrossVenues).
 */

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Saltos de la cadena de saldos sumados que se siguen como mucho (como mergedWalletIds). */
const MAX_MERGE_HOPS = 10;

export interface WalletCash {
  /** Entró en efectivo (recargas − anulaciones) desde siempre. */
  inCents: number;
  /** …de eso, en las últimas 24 h. */
  inWindowCents: number;
  /**
   * Lo que PAGÓ el cliente en efectivo en las últimas 24 h: el saldo + la
   * «Comisión del servicio» (el tope legal va por lo que se paga, no por el
   * saldo). Sin el campo, el saldo (inWindowCents).
   */
  inWindowPaidCents?: number;
  /** Devuelto en efectivo (hecho) desde siempre. */
  outCents: number;
  /** …de eso, en las últimas 24 h. */
  outWindowCents: number;
  /** Entró con bitcoin (recargas pagadas con BTCPay) desde siempre. Sin el campo, nada. */
  bitcoinInCents?: number;
  /** Lo que queda por devolver de las recargas con tarjeta (sin las de bitcoin). Sin el campo, 0. */
  cardInCents?: number;
}

/** La parte del saldo que entró con bitcoin (decisión del dueño): no se devuelve. */
export const BITCOIN_STAYS_TEXT = 'Esta parte entró con bitcoin: se queda como saldo para otra noche, no se devuelve.';

/** El efectivo del saldo y de los sumados a él (en una sola lectura). */
export async function walletCash(tx: RawTx, walletId: string, now: Date = new Date()): Promise<WalletCash> {
  const since = new Date(now.getTime() - CASH_LIMIT_WINDOW_HOURS * 60 * 60 * 1000);
  const rows = await tx.$queryRaw<Array<Record<keyof WalletCash, bigint | number | null>>>`
    WITH RECURSIVE chain AS (
      SELECT id, 0 AS hops FROM client_wallets WHERE id = ${walletId}::uuid
      UNION ALL
      SELECT w.id, c.hops + 1 FROM client_wallets w JOIN chain c ON w."mergedIntoId" = c.id
       WHERE c.hops < ${MAX_MERGE_HOPS}
    )
    SELECT
      (SELECT COALESCE(SUM(t."amountCents"), 0) FROM wallet_cash_topups t
        WHERE t."walletId" IN (SELECT id FROM chain))::bigint AS "inCents",
      (SELECT COALESCE(SUM(t."amountCents"), 0) FROM wallet_cash_topups t
        WHERE t."walletId" IN (SELECT id FROM chain) AND t."createdAt" >= ${since})::bigint AS "inWindowCents",
      (SELECT COALESCE(SUM(t."amountCents" + t."serviceFeeCents"), 0) FROM wallet_cash_topups t
        WHERE t."walletId" IN (SELECT id FROM chain) AND t."createdAt" >= ${since})::bigint AS "inWindowPaidCents",
      (SELECT COALESCE(SUM(p."amountCents"), 0) FROM wallet_payouts p
        WHERE p."walletId" IN (SELECT id FROM chain) AND p.method = 'CASH' AND p.status = 'DONE')::bigint AS "outCents",
      (SELECT COALESCE(SUM(p."amountCents"), 0) FROM wallet_payouts p
        WHERE p."walletId" IN (SELECT id FROM chain) AND p.method = 'CASH' AND p.status = 'DONE'
          AND p."createdAt" >= ${since})::bigint AS "outWindowCents",
      (SELECT COALESCE(SUM(b."amountCents"), 0) FROM payments b
        WHERE b."walletId" IN (SELECT id FROM chain) AND b.provider = 'BTCPAY'
          AND b.status IN ('AUTHORIZED', 'PARTIALLY_REFUNDED'))::bigint AS "bitcoinInCents",
      (SELECT COALESCE(SUM(LEAST(c."availableAmountCents", c."amountCents")), 0) FROM payments c
        WHERE c."walletId" IN (SELECT id FROM chain) AND c.provider IS DISTINCT FROM 'BTCPAY'
          AND c.status IN ('AUTHORIZED', 'PARTIALLY_REFUNDED'))::bigint AS "cardInCents"
  `;
  const r = rows[0];
  return {
    inCents: Number(r?.inCents ?? 0),
    inWindowCents: Number(r?.inWindowCents ?? 0),
    inWindowPaidCents: Number(r?.inWindowPaidCents ?? r?.inWindowCents ?? 0),
    outCents: Number(r?.outCents ?? 0),
    outWindowCents: Number(r?.outWindowCents ?? 0),
    bitcoinInCents: Number(r?.bitcoinInCents ?? 0),
    cardInCents: Number(r?.cardInCents ?? 0),
  };
}

/** Lo que entró en efectivo y sigue en el saldo (lo gastado cuenta antes como dinero de la tarjeta). */
export function unspentCashCents(balanceCents: number, cash: Pick<WalletCash, 'inCents' | 'outCents'>): number {
  return Math.max(0, Math.min(balanceCents, cash.inCents - cash.outCents));
}

/** Lo que se puede devolver en efectivo ahora: lo que entró en efectivo, sin llegar a 1.000 € en 24 h. */
export function cashPayoutCapCents(balanceCents: number, cash: WalletCash): number {
  const legal = CASH_LIMIT_CENTS - 1 - cash.outWindowCents;
  return Math.max(0, Math.min(unspentCashCents(balanceCents, cash), legal));
}

type CashAndBitcoin = Pick<WalletCash, 'inCents' | 'outCents' | 'bitcoinInCents' | 'cardInCents'>;

/**
 * Lo que entró con bitcoin y sigue en el saldo. Lo gastado cuenta primero
 * contra el bitcoin: queda de bitcoin lo que no es efectivo ni lo cubren las
 * recargas con tarjeta (como mucho, lo que entró con bitcoin).
 */
export function bitcoinPartCents(balanceCents: number, cash: CashAndBitcoin): number {
  const bitcoinIn = cash.bitcoinInCents ?? 0;
  if (bitcoinIn <= 0) return 0;
  const notCash = Math.max(0, balanceCents - unspentCashCents(balanceCents, cash));
  return Math.max(0, Math.min(bitcoinIn, notCash - (cash.cardInCents ?? 0)));
}

/** Lo que se puede devolver a la tarjeta: el saldo menos el efectivo que sigue en él y lo que entró con bitcoin. */
export function cardRefundCapCents(balanceCents: number, cash: CashAndBitcoin): number {
  return Math.max(0, balanceCents - unspentCashCents(balanceCents, cash) - bitcoinPartCents(balanceCents, cash));
}

/** Lo que saldría hoy de un saldo por cada camino (lo mismo que apuntan payoutCash y claimCardPayout). */
export interface PayoutAmounts {
  /** En efectivo, ahora. */
  cashOutCents: number;
  /** A la tarjeta (el dueño, en el banco). */
  cardRefundCents: number;
  /** Efectivo que hoy no puede salir por el tope de 24 h: sale más tarde, en efectivo (no a la tarjeta). */
  cashLaterCents: number;
  /** Entró con bitcoin: no se devuelve (ni a la tarjeta ni en efectivo); se queda como saldo para otra noche. */
  bitcoinCents: number;
}

export function payoutAmounts(balanceCents: number, cash: WalletCash): PayoutAmounts {
  if (balanceCents <= 0) return { cashOutCents: 0, cardRefundCents: 0, cashLaterCents: 0, bitcoinCents: 0 };
  const cashOutCents = cashPayoutCapCents(balanceCents, cash);
  return {
    cashOutCents,
    cardRefundCents: cardRefundCapCents(balanceCents, cash),
    cashLaterCents: unspentCashCents(balanceCents, cash) - cashOutCents,
    bitcoinCents: bitcoinPartCents(balanceCents, cash),
  };
}

/**
 * null si la recarga en efectivo cabe; si no, por qué no (el total de 24 h
 * llegaría a 1.000 €). `paidCents`: lo que paga ahora el cliente (el saldo +
 * la «Comisión del servicio», si la hay); lo de antes, también con su comisión.
 */
export function cashTopUpOverLimit(
  paidCents: number,
  cash: Pick<WalletCash, 'inWindowCents'> & Partial<Pick<WalletCash, 'inWindowPaidCents'>>,
): string | null {
  const before = cash.inWindowPaidCents ?? cash.inWindowCents;
  if (before + paidCents < CASH_LIMIT_CENTS) return null;
  const left = Math.max(0, CASH_LIMIT_CENTS - 1 - before);
  return left > 0
    ? `En efectivo, este saldo ya lleva ${eur(before)} en 24 h: como mucho ${eur(left)} más (los pagos troceados suman). El resto, con tarjeta.`
    : `En efectivo, este saldo ya lleva ${eur(before)} en 24 h y no puede llegar a 1.000 €: el resto, con tarjeta.`;
}

/** Por qué no se devuelve nada en efectivo (cap = 0). */
export function cashPayoutRefusal(balanceCents: number, cash: WalletCash): string {
  if (unspentCashCents(balanceCents, cash) === 0) return notCashText(balanceCents, cash, balanceCents);
  return `A este saldo ya se le devolvieron ${eur(cash.outWindowCents)} en efectivo en 24 h y no puede llegar a 1.000 €: el resto, «A la tarjeta» (el dueño) o mañana.`;
}

/**
 * Por qué no se devuelve todo el saldo en efectivo (la salida de recepción lo
 * dice antes de tocar el botón). null: se devuelve todo, o no tiene nada.
 */
export function cashPayoutNote(balanceCents: number, cash: WalletCash): string | null {
  if (balanceCents <= 0) return null;
  const cap = cashPayoutCapCents(balanceCents, cash);
  if (cap >= balanceCents) return null;
  if (cap === 0) return cashPayoutRefusal(balanceCents, cash);
  if (cap < unspentCashCents(balanceCents, cash)) {
    return `En efectivo, como mucho ${eur(cap)}: a este saldo ya se le devolvieron ${eur(cash.outWindowCents)} en efectivo en 24 h. El resto, «A la tarjeta» (el dueño) o mañana.`;
  }
  return notCashText(balanceCents - cap, cash, balanceCents, true);
}

/**
 * Lo que no entró en efectivo, y qué pasa con ello: lo de tarjeta lo devuelve
 * el dueño «A la tarjeta»; lo de bitcoin no se devuelve (BITCOIN_STAYS_TEXT).
 * `rest`: lo que queda tras el efectivo.
 */
function notCashText(notCashCents: number, cash: WalletCash, balanceCents: number, rest = false): string {
  const bitcoin = Math.min(notCashCents, bitcoinPartCents(balanceCents, cash));
  const card = notCashCents - bitcoin;
  if (bitcoin === 0) {
    return rest
      ? `Los otros ${eur(notCashCents)} entraron con tarjeta: los devuelve el dueño «A la tarjeta».`
      : 'Este saldo entró con tarjeta: no se devuelve en efectivo. Lo devuelve el dueño «A la tarjeta».';
  }
  if (card === 0) {
    return rest
      ? `Los otros ${eur(notCashCents)} entraron con bitcoin. ${BITCOIN_STAYS_TEXT}`
      : `Este saldo entró con bitcoin: se queda como saldo para otra noche, no se devuelve (ni en efectivo ni a la tarjeta).`;
  }
  const split = `${eur(card)} entraron con tarjeta (los devuelve el dueño «A la tarjeta») y ${eur(bitcoin)} con bitcoin. ${BITCOIN_STAYS_TEXT}`;
  return rest ? `De los otros ${eur(notCashCents)}, ${split}` : `Este saldo no entró en efectivo: ${split}`;
}
