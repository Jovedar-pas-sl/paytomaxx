import { RECENT_TOP_UP_MINUTES, type RecentTopUp } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * «Cargada hace 2 min: 50 € en efectivo (Sergio)» en la fila de la ficha
 * (estudio de fichas, A4): la última recarga de un saldo si fue hace menos de
 * RECENT_TOP_UP_MINUTES. Sin migración: se lee lo que ya existe, la recarga
 * en efectivo (wallet_cash_topups, sin las anuladas) y la recarga con tarjeta
 * pagada (payments del saldo, AUTHORIZED). De quien la cargó, solo el nombre
 * de pila; nunca el email.
 */

export type RecentTopUpTx = Pick<TransactionalClient, 'walletCashTopUp' | 'payment' | 'user'>;

/** Una recarga del saldo, la de efectivo o la de tarjeta. */
export interface TopUpCandidate {
  at: Date;
  amountCents: number;
  method: RecentTopUp['method'];
  byUserId: string | null;
}

/** «Sergio García» → «Sergio». Sin nombre visible: null (el email no se enseña nunca). */
export function firstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first : null;
}

/** La más reciente de las que caen en la ventana (null: ninguna). */
export function latestTopUp(candidates: ReadonlyArray<TopUpCandidate | null>, now: Date): TopUpCandidate | null {
  const since = now.getTime() - RECENT_TOP_UP_MINUTES * 60_000;
  let best: TopUpCandidate | null = null;
  for (const c of candidates) {
    if (!c || c.at.getTime() < since) continue;
    if (!best || c.at.getTime() > best.at.getTime()) best = c;
  }
  return best;
}

/** La última recarga del saldo si es reciente, con el nombre de pila de quien la cargó. */
export async function recentTopUp(tx: RecentTopUpTx, walletId: string, now: Date = new Date()): Promise<RecentTopUp | null> {
  const since = new Date(now.getTime() - RECENT_TOP_UP_MINUTES * 60_000);
  const cash = await tx.walletCashTopUp.findFirst({
    // Una anulada no cuenta (ni la fila negativa de la anulación).
    where: { walletId, voidOfId: null, voidedBy: { is: null }, createdAt: { gte: since }, amountCents: { gt: 0 } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, amountCents: true, takenByUserId: true },
  });
  const card = await tx.payment.findFirst({
    where: { walletId, status: 'AUTHORIZED', authorizedAt: { gte: since } },
    orderBy: { authorizedAt: 'desc' },
    select: { authorizedAt: true, amountCents: true, createdByUserId: true },
  });
  const pick = latestTopUp(
    [
      cash ? { at: cash.createdAt, amountCents: cash.amountCents, method: 'cash', byUserId: cash.takenByUserId } : null,
      card?.authorizedAt ? { at: card.authorizedAt, amountCents: card.amountCents, method: 'card', byUserId: card.createdByUserId } : null,
    ],
    now,
  );
  if (!pick) return null;
  const user = pick.byUserId ? await tx.user.findUnique({ where: { id: pick.byUserId }, select: { displayName: true } }) : null;
  return { at: pick.at.toISOString(), amountCents: pick.amountCents, method: pick.method, byName: firstName(user?.displayName) };
}
