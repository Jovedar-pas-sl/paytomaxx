import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { normalizeWalletCardUid } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';
import { sameWalletGroup } from './wallet-rules';
import { assertNotStaffCardTx } from './staff-card-guard';

/**
 * Ficha NFC del saldo: lo que comparten el personal (WalletChargesService), el
 * datáfono de recepción y «Preparar fichas» (WalletCardsService). Funciones con
 * la base que les pasan: sin cambiar quién depende de quién.
 *
 * Ciclo de vida (20261021100000): STOCK (grabada, sin dar) → ISSUED (dada a un
 * saldo) → RETURNED (devuelta, otra vez en el stock) | LOST (perdida o
 * sustituida) | BLOCKED. Solo una ISSUED dice de qué saldo es; una por saldo
 * (índice parcial en SQL). Cada paso deja un evento (wallet_card_events, con
 * el local de ese momento): los contadores de la noche cuentan eventos.
 *
 * Paso 1 de 2 de 20261021100000: el API anterior escribe ACTIVE. Con saldo
 * vale como ISSUED; sin saldo, como STOCK.
 */

/** Quién da o prepara la ficha: una persona o el datáfono de recepción. */
export interface CardBy {
  userId: string | null;
  terminalId?: string | null;
}

/** Estados de una ficha dada a un saldo (ACTIVE: la del API anterior). */
export const ISSUED_CARD_STATUSES: string[] = ['ISSUED', 'ACTIVE'];

/** ¿Está dada a un saldo? (ISSUED o, del API anterior, ACTIVE con saldo). */
export function isIssuedCard(card: { status: string; walletId: string | null }): boolean {
  return ISSUED_CARD_STATUSES.includes(card.status) && card.walletId !== null;
}

/** Un código pedido y sin grabar se borra pasado este tiempo (se pide uno nuevo en cada toque). */
export const PENDING_CODE_TTL_HOURS = 24;
/** Cuántos códigos sin grabar se borran como mucho de una vez. */
const PURGE_BATCH = 200;

export type CardEventKind = 'ISSUED' | 'RETURNED' | 'LOST' | 'BLOCKED';

type EventTx = Pick<TransactionalClient, 'walletCardEvent'>;
type CardTx = Pick<TransactionalClient, 'walletCard' | 'walletCardEvent'>;

/** Apunta lo que ha pasado con estas fichas (en la misma transacción que el cambio). */
export async function recordCardEvents(
  tx: EventTx,
  events: ReadonlyArray<{ cardId: string; walletId: string | null; kind: CardEventKind }>,
  at: { venueId: string; by?: CardBy; now?: Date },
): Promise<void> {
  if (events.length === 0) return;
  await tx.walletCardEvent.createMany({
    data: events.map((e) => ({
      cardId: e.cardId,
      walletId: e.walletId,
      kind: e.kind,
      venueId: at.venueId,
      byUserId: at.by?.userId ?? null,
      terminalId: at.by?.terminalId ?? null,
      ...(at.now ? { at: at.now } : {}),
    })),
  });
}

/** Código nuevo (128 bits, base64url): solo las fichas grabadas así se pueden dar. */
export function newCardToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Código para grabar en una ficha vacía, apuntado en el stock del local (aún
 * sin `stockedAt`: grabada o no, eso lo dice quien la graba). No se reutiliza
 * el de un toque anterior: si aquella grabación sí se hizo y se perdió la
 * respuesta, dos fichas llevarían el mismo código. En su lugar se borran los
 * que llevan más de PENDING_CODE_TTL_HOURS sin grabar.
 */
export async function createCardToken(db: PrismaService, venueId: string, by: CardBy): Promise<string> {
  const token = newCardToken();
  await db.acrossVenues(async (tx) => {
    await purgePendingCodes(tx, venueId);
    await tx.walletCard.create({ data: { token, status: 'STOCK', venueId, linkedById: by.userId } });
  });
  return token;
}

/** Borra los códigos pedidos y nunca grabados (ni dados, ni usados) de hace más de un día. */
export async function purgePendingCodes(
  tx: Pick<TransactionalClient, '$executeRaw'>,
  venueId: string,
  now: Date = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - PENDING_CODE_TTL_HOURS * 60 * 60 * 1000);
  return tx.$executeRaw`
    DELETE FROM wallet_cards
     WHERE id IN (
       SELECT c.id FROM wallet_cards c
        WHERE c."venueId" = ${venueId}::uuid
          AND c.status = 'STOCK' AND c."stockedAt" IS NULL
          AND c."walletId" IS NULL AND c."linkedAt" IS NULL AND c."lastUsedAt" IS NULL
          AND c."createdAt" < ${before}
          AND NOT EXISTS (SELECT 1 FROM wallet_card_events e WHERE e."cardId" = c.id)
        LIMIT ${PURGE_BATCH}
     )
  `;
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
  if (status === 'LOST') return 'Esta ficha está marcada como perdida: usa otra (o acércala en «Preparar fichas» para recuperarla)';
  return null;
}

/** La ficha es de este grupo de locales (o aún no es de ninguno). */
export async function cardInGroup(
  tx: Pick<TransactionalClient, 'venue'>,
  card: { venueId: string | null },
  venueId: string,
): Promise<boolean> {
  if (!card.venueId || card.venueId === venueId) return true;
  const [home, here] = await Promise.all([
    tx.venue.findUnique({ where: { id: card.venueId }, select: { walletGroup: true } }),
    tx.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } }),
  ]);
  return sameWalletGroup(
    { tenantId: card.venueId, walletGroup: home?.walletGroup ?? null },
    { id: venueId, walletGroup: here?.walletGroup ?? null },
  );
}

/** Las fichas dadas a otro saldo que se sustituyen: quedan perdidas (fuera del stock) y sin saldo. */
async function replaceCards(tx: CardTx, ids: ReadonlyArray<string>, walletId: string, venueId: string, now: Date) {
  if (ids.length === 0) return;
  await tx.walletCard.updateMany({ where: { id: { in: [...ids] } }, data: { walletId: null, status: 'LOST', lostAt: now } });
  await recordCardEvents(tx, ids.map((cardId) => ({ cardId, walletId, kind: 'LOST' as const })), { venueId, now });
}

/**
 * Da la ficha al saldo (ISSUED). Siempre en este orden (saldo, ficha), los dos
 * bloqueados: dos «dar ficha» a la vez esperan. Una ficha de otro grupo de
 * locales, o de otro cliente con saldo, no se da; la de un saldo ya gastado o
 * cerrado, sí (vuelve a salir). Una ficha por saldo: la que tenía queda como
 * perdida (sustituida: el cliente la perdió o se la queda) y vuelve al stock
 * si alguien la acerca en «Preparar fichas». Devuelve cuántas se sustituyeron.
 */
export async function attachCard(
  db: PrismaService,
  input: { walletId: string; venueId: string; card: string; uid: string | null; by: CardBy },
): Promise<number> {
  return db.acrossVenues((tx) => attachCardInTx(tx, input));
}

/**
 * attachCard dentro de una transacción ya abierta (con acrossVenues): la
 * recarga en efectivo de un saldo nuevo da su ficha en la misma operación.
 */
export async function attachCardInTx(
  tx: TransactionalClient,
  input: { walletId: string; venueId: string; card: string; uid: string | null; by: CardBy },
): Promise<number> {
  const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
  await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${input.walletId}::uuid FOR UPDATE`;
  const card = await lockCard(tx, input.card);
  // La ficha de una compañera no se da a un saldo.
  if (!card) await assertNotStaffCardTx(tx, input.card);
  if (!card || !(await cardInGroup(tx, card, input.venueId))) {
    throw new BadRequestException('Esta ficha no es nuestra: grábala desde la app (Darle una ficha)');
  }
  const unusable = cardUnusableText(card.status);
  if (unusable) throw new ConflictException(unusable);
  if (card.uid && uid && card.uid !== uid) throw new ConflictException('Esta ficha no es la original (¿copiada?): usa otra');
  const now = new Date();
  const previousHolder = isIssuedCard(card) && card.walletId !== input.walletId ? card.walletId : null;
  if (previousHolder) {
    const other = await tx.clientWallet.findUnique({
      where: { id: previousHolder },
      select: { status: true, balanceCents: true },
    });
    if (other?.status === 'ACTIVE' && other.balanceCents > 0) {
      throw new ConflictException('Esta ficha es de otro cliente que aún tiene saldo');
    }
  }
  const replaced = await tx.walletCard.findMany({
    where: { walletId: input.walletId, status: { in: ISSUED_CARD_STATUSES }, NOT: { id: card.id } },
    select: { id: true },
  });
  await replaceCards(tx, replaced.map((c) => c.id), input.walletId, input.venueId, now);
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
  const alreadyHers = isIssuedCard(card) && card.walletId === input.walletId;
  await recordCardEvents(
    tx,
    [
      // Era de un saldo ya gastado o cerrado: ha vuelto (está aquí) y sale otra vez.
      ...(previousHolder ? [{ cardId: card.id, walletId: previousHolder, kind: 'RETURNED' as const }] : []),
      ...(alreadyHers ? [] : [{ cardId: card.id, walletId: input.walletId, kind: 'ISSUED' as const }]),
    ],
    { venueId: input.venueId, by: input.by, now },
  );
  return replaced.length;
}

/**
 * El saldo se cerró (devuelto al cliente, «Me voy»): sus fichas vuelven al
 * stock del local que lo devuelve. Dentro de la transacción de la devolución.
 */
export async function returnWalletCards(tx: CardTx, walletId: string, venueId: string, by?: CardBy): Promise<number> {
  const cards = await tx.walletCard.findMany({
    where: { walletId, status: { in: ISSUED_CARD_STATUSES } },
    select: { id: true },
  });
  if (cards.length === 0) return 0;
  const now = new Date();
  await tx.walletCard.updateMany({
    where: { id: { in: cards.map((c) => c.id) } },
    data: { walletId: null, status: 'RETURNED', returnedAt: now, venueId },
  });
  await recordCardEvents(tx, cards.map((c) => ({ cardId: c.id, walletId, kind: 'RETURNED' as const })), { venueId, by, now });
  return cards.length;
}

/**
 * Saldo sumado a otro (mergeInto): su ficha pasa al saldo bueno (si no, al
 * pagar diría «no tiene saldo» y el stock la vería libre). Si el saldo bueno
 * ya tenía ficha, vale la nueva (la que el cliente acaba de recibir) y la
 * otra queda sustituida. Sin evento de entregada: el cliente ya la tenía.
 * Dentro de la transacción de la fusión, con los dos saldos bloqueados.
 */
export async function moveWalletCards(
  tx: CardTx,
  from: { walletId: string; venueId: string },
  toWalletId: string,
): Promise<number> {
  const moving = await tx.walletCard.findMany({
    where: { walletId: from.walletId, status: { in: ISSUED_CARD_STATUSES } },
    orderBy: { linkedAt: { sort: 'desc', nulls: 'last' } },
    select: { id: true },
  });
  const [keep, ...extra] = moving;
  if (!keep) return 0;
  const now = new Date();
  const replaced = await tx.walletCard.findMany({
    where: { walletId: toWalletId, status: { in: ISSUED_CARD_STATUSES } },
    select: { id: true },
  });
  await replaceCards(tx, [...replaced, ...extra].map((c) => c.id), toWalletId, from.venueId, now);
  await tx.walletCard.update({ where: { id: keep.id }, data: { walletId: toWalletId, status: 'ISSUED' } });
  return moving.length;
}
