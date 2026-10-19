import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { normalizeWalletCardUid } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Ficha NFC del saldo: lo que comparten el personal (WalletChargesService), el
 * datáfono de recepción y «Preparar fichas» (WalletCardsService). Funciones con
 * la base que les pasan: sin cambiar quién depende de quién.
 *
 * Ciclo de vida (20261021100000): STOCK (grabada, sin dar) → ISSUED (dada a un
 * saldo) → RETURNED (devuelta, otra vez en el stock) | LOST | BLOCKED. Solo una
 * ISSUED dice de qué saldo es; una por saldo (índice parcial en SQL).
 */

/** Quién da o prepara la ficha: una persona o el datáfono de recepción. */
export interface CardBy {
  userId: string | null;
  terminalId?: string | null;
}

/** Código nuevo (128 bits, base64url): solo las fichas grabadas así se pueden dar. */
export function newCardToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Código para grabar en una ficha vacía, apuntado en el stock del local (aún
 * sin `stockedAt`: grabada o no, eso lo dice quien la graba).
 */
export async function createCardToken(db: PrismaService, venueId: string, by: CardBy): Promise<string> {
  const token = newCardToken();
  await db.acrossVenues((tx) =>
    tx.walletCard.create({ data: { token, status: 'STOCK', venueId, linkedById: by.userId } }),
  );
  return token;
}

/** Fila de la ficha bloqueada (FOR UPDATE) mientras se da o se mueve. */
export interface LockedCard {
  id: string;
  uid: string | null;
  walletId: string | null;
  status: string;
  venueId: string | null;
}

export async function lockCard(tx: Pick<TransactionalClient, '$queryRaw'>, token: string): Promise<LockedCard | null> {
  const rows = await tx.$queryRaw<LockedCard[]>`
    SELECT id, uid, "walletId", status, "venueId" FROM wallet_cards WHERE token = ${token} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Una ficha perdida o bloqueada no se da a nadie. */
export function cardUnusableText(status: string): string | null {
  if (status === 'BLOCKED') return 'Esta ficha está bloqueada: usa otra';
  if (status === 'LOST') return 'Esta ficha está marcada como perdida: usa otra (o que el encargado la recupere)';
  return null;
}

/**
 * Da la ficha al saldo (ISSUED). Siempre en este orden (saldo, ficha), los dos
 * bloqueados: dos «dar ficha» a la vez esperan. Una ficha de otro cliente con
 * saldo no se da; la de un saldo ya gastado o cerrado, sí (vuelve a salir).
 * Una ficha por saldo: la que tenía vuelve al stock. Devuelve cuántas se soltaron.
 */
export async function attachCard(
  db: PrismaService,
  input: { walletId: string; venueId: string; card: string; uid: string | null; by: CardBy },
): Promise<number> {
  const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
  return db.acrossVenues(async (tx) => {
    await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${input.walletId}::uuid FOR UPDATE`;
    const card = await lockCard(tx, input.card);
    if (!card) throw new BadRequestException('Esta ficha no es nuestra: grábala desde la app (Darle una ficha)');
    const unusable = cardUnusableText(card.status);
    if (unusable) throw new ConflictException(unusable);
    if (card.uid && uid && card.uid !== uid) throw new ConflictException('Esta ficha no es la original (¿copiada?): usa otra');
    if (card.status === 'ISSUED' && card.walletId && card.walletId !== input.walletId) {
      const other = await tx.clientWallet.findUnique({
        where: { id: card.walletId },
        select: { status: true, balanceCents: true },
      });
      if (other?.status === 'ACTIVE' && other.balanceCents > 0) {
        throw new ConflictException('Esta ficha es de otro cliente que aún tiene saldo');
      }
    }
    const now = new Date();
    const old = await tx.walletCard.updateMany({
      where: { walletId: input.walletId, status: 'ISSUED', NOT: { id: card.id } },
      data: { walletId: null, status: 'RETURNED', returnedAt: now, venueId: input.venueId },
    });
    await tx.walletCard.update({
      where: { id: card.id },
      data: {
        walletId: input.walletId,
        status: 'ISSUED',
        uid: card.uid ?? uid,
        linkedById: input.by.userId,
        linkedAt: now,
        venueId: input.venueId,
      },
    });
    return old.count;
  });
}

/**
 * El saldo se cerró (devuelto al cliente, «Me voy»): sus fichas vuelven al
 * stock del local que lo devuelve. Dentro de la transacción de la devolución.
 */
export async function returnWalletCards(
  tx: Pick<TransactionalClient, 'walletCard'>,
  walletId: string,
  venueId: string,
): Promise<number> {
  const res = await tx.walletCard.updateMany({
    where: { walletId, status: 'ISSUED' },
    data: { walletId: null, status: 'RETURNED', returnedAt: new Date(), venueId },
  });
  return res.count;
}
