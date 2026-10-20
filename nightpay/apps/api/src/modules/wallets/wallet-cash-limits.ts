import { CASH_LIMIT_CENTS, CASH_LIMIT_WINDOW_HOURS } from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';

/**
 * El efectivo de un saldo (y de los saldos sumados a él, mergedIntoId) y sus
 * reglas, para que el efectivo no se convierta en dinero del banco ni al revés
 * y no se trocee para saltar el tope legal (art. 7 de la Ley 7/2012):
 *  - lo que entra en efectivo en 24 h (recargas − anulaciones) no llega a 1.000 €;
 *  - en efectivo solo se devuelve lo que entró en efectivo y no ha salido, y
 *    lo devuelto en efectivo en 24 h tampoco llega a 1.000 €;
 *  - a la tarjeta, como mucho el saldo menos ese efectivo (lo gastado cuenta
 *    primero como dinero de la tarjeta).
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
  /** Devuelto en efectivo (hecho) desde siempre. */
  outCents: number;
  /** …de eso, en las últimas 24 h. */
  outWindowCents: number;
}

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
      (SELECT COALESCE(SUM(p."amountCents"), 0) FROM wallet_payouts p
        WHERE p."walletId" IN (SELECT id FROM chain) AND p.method = 'CASH' AND p.status = 'DONE')::bigint AS "outCents",
      (SELECT COALESCE(SUM(p."amountCents"), 0) FROM wallet_payouts p
        WHERE p."walletId" IN (SELECT id FROM chain) AND p.method = 'CASH' AND p.status = 'DONE'
          AND p."createdAt" >= ${since})::bigint AS "outWindowCents"
  `;
  const r = rows[0];
  return {
    inCents: Number(r?.inCents ?? 0),
    inWindowCents: Number(r?.inWindowCents ?? 0),
    outCents: Number(r?.outCents ?? 0),
    outWindowCents: Number(r?.outWindowCents ?? 0),
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

/** Lo que se puede devolver a la tarjeta: el saldo menos el efectivo que sigue en él. */
export function cardRefundCapCents(balanceCents: number, cash: Pick<WalletCash, 'inCents' | 'outCents'>): number {
  return Math.max(0, balanceCents - unspentCashCents(balanceCents, cash));
}

/** null si la recarga en efectivo cabe; si no, por qué no (el total de 24 h llegaría a 1.000 €). */
export function cashTopUpOverLimit(amountCents: number, cash: Pick<WalletCash, 'inWindowCents'>): string | null {
  if (cash.inWindowCents + amountCents < CASH_LIMIT_CENTS) return null;
  const left = Math.max(0, CASH_LIMIT_CENTS - 1 - cash.inWindowCents);
  return left > 0
    ? `En efectivo, este saldo ya lleva ${eur(cash.inWindowCents)} en 24 h: como mucho ${eur(left)} más (los pagos troceados suman). El resto, con tarjeta.`
    : `En efectivo, este saldo ya lleva ${eur(cash.inWindowCents)} en 24 h y no puede llegar a 1.000 €: el resto, con tarjeta.`;
}

/** Por qué no se devuelve nada en efectivo (cap = 0). */
export function cashPayoutRefusal(balanceCents: number, cash: WalletCash): string {
  if (unspentCashCents(balanceCents, cash) === 0) {
    return 'Este saldo entró con tarjeta: no se devuelve en efectivo. Lo devuelve el dueño «A la tarjeta».';
  }
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
  return `Los otros ${eur(balanceCents - cap)} entraron con tarjeta: los devuelve el dueño «A la tarjeta».`;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
