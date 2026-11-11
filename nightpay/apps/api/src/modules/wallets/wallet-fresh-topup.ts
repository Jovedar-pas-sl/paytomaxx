import { ConflictException } from '@nestjs/common';
import { normalizeWalletCardUid } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { isIssuedCard } from './wallet-card-ops';

/** Sin leer la ficha (solo su enlace): no vale como «la ficha delante». */
export const FICHA_TAP_NEEDED = 'Acerca la ficha al móvil: hay que leerla (no basta con su enlace).';
export const FICHA_COPY = 'Esta ficha no es la original (¿copiada?): avisa al encargado.';

/**
 * La ficha física delante, como en la salida de efectivo: si la ficha tiene
 * uid, hay que haberla leído (su uid) y que coincida. Sin uid leído, 409
 * «acerca la ficha»; con otro uid, 409 «no es la original». Las fichas sin uid
 * apuntado (de antes) no lo piden.
 */
export function assertFichaInHand(cardUid: string | null, readUid: string | null | undefined): void {
  if (!cardUid) return;
  const uid = readUid ? normalizeWalletCardUid(readUid) : null;
  if (!uid) throw new ConflictException({ message: FICHA_TAP_NEEDED, code: 'FICHA_TAP_NEEDED' });
  if (normalizeWalletCardUid(cardUid) !== uid) throw new ConflictException({ message: FICHA_COPY, code: 'FICHA_COPY' });
}

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
  /** El cobro con tarjeta de esa recarga (null = fue en efectivo). */
  paymentId: string | null;
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
        select: { id: true, createdByUserId: true, authorizedAt: true, posTerminalId: true, createdAt: true },
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
    ? {
        paymentId: payment.id,
        userId: payment.createdByUserId,
        terminalId: payment.posTerminalId,
        at: payment.authorizedAt,
        createdAt: payment.createdAt,
      }
    : null;
  const inCash: FirstTopUp | null = cash
    ? { paymentId: null, userId: cash.takenByUserId, terminalId: cash.terminalId, at: cash.createdAt, createdAt: cash.createdAt }
    : null;
  if (!card) return inCash;
  if (!inCash) return card;
  return inCash.createdAt < card.createdAt ? inCash : card;
}

/**
 * B10: recepción pone el PIN a un saldo que ya existía (sin PIN) justo después
 * de recargarlo: la ficha acercada es de ese saldo (con su número de serie si
 * lo tiene) y esta persona le hizo una recarga (efectivo sin anular o tarjeta
 * pagada) en los últimos 15 min. El cliente lo teclea él; con PIN no se cambia.
 */
export async function pinAfterRecharge(
  db: PrismaService,
  a: { walletId: string; userId: string; card: string; uid?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - FRESH_TOPUP_MS);
  const [card, cash, paid] = await Promise.all([
    db.acrossVenues((tx) => tx.walletCard.findUnique({ where: { token: a.card }, select: { walletId: true, status: true, uid: true } })),
    db.acrossVenues((tx) =>
      tx.walletCashTopUp.findFirst({
        where: { walletId: a.walletId, takenByUserId: a.userId, voidOfId: null, voidedBy: { is: null }, amountCents: { gt: 0 }, createdAt: { gte: since } },
        select: { id: true },
      }),
    ),
    db.acrossVenues((tx) =>
      tx.payment.findFirst({
        where: { walletId: a.walletId, createdByUserId: a.userId, status: 'AUTHORIZED', authorizedAt: { gte: since } },
        select: { id: true },
      }),
    ),
  ]);
  if (!card || !isIssuedCard(card) || card.walletId !== a.walletId) return false;
  if (cash === null && paid === null) return false;
  // Su ficha y una recarga suya de ahora: la ficha tiene que estar delante (leída).
  assertFichaInHand(card.uid, a.uid);
  return true;
}

/** ¿La primera recarga es de quien pregunta y de hace menos de 15 min? */
export function isFreshTopUpBy(first: FirstTopUp | null, by: TopUpBy, now: Date = new Date()): boolean {
  if (!first || !first.at) return false;
  const mine = 'userId' in by ? first.userId === by.userId : first.terminalId === by.terminalId;
  return mine && first.at.getTime() >= now.getTime() - FRESH_TOPUP_MS;
}
