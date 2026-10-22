import { ConflictException, NotFoundException } from '@nestjs/common';
import { isWalletCardToken, normalizeWalletCardUid } from '@nightpay/contracts';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { isIssuedCard } from './wallet-card-ops';
import { normalizeWalletCode, sameWalletGroup } from './wallet-rules';

/**
 * El saldo al que se suma una recarga en la recepción: el de su código o el de
 * su ficha. A diferencia de pagar, vale un saldo ya gastado (DEPLETED): la
 * recarga lo reabre. Un saldo sumado a otro lleva a ese otro (allí está su
 * dinero). No valen los cerrados (devueltos, caducados), los bloqueados por el
 * super-admin ni los de otro grupo de locales.
 */

/**
 * El código, la ficha acercada o (solo recargas en efectivo de recepción) la
 * ficha buscada por su número impreso: FichaNumbersService la encuentra y
 * pasa su id; nunca llega del cliente así.
 */
export type TopUpRef = { code: string } | { card: string; uid?: string | null } | { printed: { cardId: string } };

export interface TopUpTarget {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  shortCode: string | null;
  pinHash: string | null;
  status: string;
}

/** Saldos sumados uno a otro que se siguen como mucho. */
const MAX_MERGE_HOPS = 5;

const NO_CARD = 'Esta ficha no es de ningún saldo: dásela al cliente al recargar';

export async function topUpTarget(db: PrismaService, venueId: string, ref: TopUpRef): Promise<TopUpTarget> {
  const venue = await db.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
  const group = { id: venueId, walletGroup: venue?.walletGroup ?? null };
  const first = 'code' in ref ? await byCode(db, ref.code) : 'printed' in ref ? await byCardId(db, ref.printed.cardId) : await byCard(db, ref);
  let wallet = first;
  for (let hops = 0; wallet?.mergedIntoId && hops < MAX_MERGE_HOPS; hops += 1) {
    const nextId: string = wallet.mergedIntoId;
    wallet = await db.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: nextId } }));
  }
  if (!wallet || !sameWalletGroup(wallet, group)) {
    throw new NotFoundException('code' in ref ? 'No hay ningún saldo con ese código en este local' : 'Esta ficha no es de este local');
  }
  if (wallet.blockedAt) throw new ConflictException('Este saldo está bloqueado: no se puede recargar. Avisa al encargado.');
  if (wallet.status !== 'ACTIVE' && wallet.status !== 'DEPLETED') {
    throw new ConflictException('Este saldo ya está cerrado (devuelto): haz un saldo nuevo');
  }
  return {
    id: wallet.id,
    tenantId: wallet.tenantId,
    walletGroup: wallet.walletGroup,
    shortCode: wallet.shortCode,
    pinHash: wallet.pinHash,
    status: wallet.status,
  };
}

async function byCode(db: PrismaService, raw: string) {
  const code = normalizeWalletCode(raw);
  if (code.length !== 6) throw new NotFoundException('El código del cliente tiene 6 letras o números');
  return db.acrossVenues((tx) => tx.clientWallet.findFirst({ where: { shortCode: code, status: 'ACTIVE' } }));
}

async function byCardId(db: PrismaService, cardId: string) {
  const card = await db.acrossVenues((tx) => tx.walletCard.findUnique({ where: { id: cardId } }));
  if (!card || !isIssuedCard(card) || !card.walletId) throw new NotFoundException(NO_CARD);
  const walletId = card.walletId;
  return db.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } }));
}

async function byCard(db: PrismaService, ref: { card: string; uid?: string | null }) {
  if (!isWalletCardToken(ref.card)) throw new NotFoundException(NO_CARD);
  const card = await db.acrossVenues((tx) => tx.walletCard.findUnique({ where: { token: ref.card } }));
  if (!card || !isIssuedCard(card) || !card.walletId) throw new NotFoundException(NO_CARD);
  const uid = ref.uid ? normalizeWalletCardUid(ref.uid) : null;
  if (card.uid && uid && card.uid !== uid) {
    throw new ConflictException('Esta ficha no es la original (¿copiada?): avisa al encargado');
  }
  const walletId = card.walletId;
  return db.acrossVenues((tx) => tx.clientWallet.findUnique({ where: { id: walletId } }));
}
