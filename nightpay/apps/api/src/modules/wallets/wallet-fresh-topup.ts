import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * «Recién recargado»: la recarga que creó el saldo la cobró esta persona (o
 * este datáfono de recepción) hace menos de 15 minutos, así que el cliente
 * está delante. Abre la puerta a elegir el primer PIN y a darle ficha sin el
 * encargado. Solo la primera recarga: recargar un saldo viejo no la reabre.
 * Cuenta tanto la recarga con tarjeta (payments) como la de efectivo
 * (wallet_cash_topups): la primera de las dos.
 */

/** Ventana tras la recarga en la que quien la cobró pone el primer PIN o da la ficha. */
export const FRESH_TOPUP_MS = 15 * 60 * 1000;

export interface FirstTopUp {
  userId: string | null;
  terminalId: string | null;
  /** Cuándo quedó cargada (autorización del banco o el momento del efectivo); null = sin pagar. */
  at: Date | null;
  createdAt: Date;
}

/** Quién pregunta: la persona de la app o el datáfono de recepción. */
export type TopUpBy = { userId: string } | { terminalId: string };

/** La primera recarga del saldo (con tarjeta o en efectivo), o null si no hay. */
export async function firstTopUp(db: PrismaService, walletId: string): Promise<FirstTopUp | null> {
  const [payment, cash] = await Promise.all([
    db.acrossVenues((tx) =>
      tx.payment.findFirst({
        where: { walletId },
        orderBy: { createdAt: 'asc' },
        select: { createdByUserId: true, authorizedAt: true, posTerminalId: true, createdAt: true },
      }),
    ),
    db.acrossVenues((tx) =>
      tx.walletCashTopUp.findFirst({
        where: { walletId },
        orderBy: { createdAt: 'asc' },
        select: { takenByUserId: true, terminalId: true, createdAt: true },
      }),
    ),
  ]);
  const card: FirstTopUp | null = payment
    ? { userId: payment.createdByUserId, terminalId: payment.posTerminalId, at: payment.authorizedAt, createdAt: payment.createdAt }
    : null;
  const inCash: FirstTopUp | null = cash
    ? { userId: cash.takenByUserId, terminalId: cash.terminalId, at: cash.createdAt, createdAt: cash.createdAt }
    : null;
  if (!card) return inCash;
  if (!inCash) return card;
  return inCash.createdAt < card.createdAt ? inCash : card;
}

/** ¿La primera recarga es de quien pregunta y de hace menos de 15 min? */
export function isFreshTopUpBy(first: FirstTopUp | null, by: TopUpBy, now: Date = new Date()): boolean {
  if (!first || !first.at) return false;
  const mine = 'userId' in by ? first.userId === by.userId : first.terminalId === by.terminalId;
  return mine && first.at.getTime() >= now.getTime() - FRESH_TOPUP_MS;
}
