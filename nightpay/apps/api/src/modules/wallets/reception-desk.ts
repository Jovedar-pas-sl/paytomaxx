import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  isWalletCardToken,
  normalizeWalletCardUid,
  SALDO_SE_QUEDA_TEXT,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
} from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { ISSUED_CARD_STATUSES, cardInGroup, cardUnusableText, isIssuedCard } from './wallet-card-ops';
import { formatWalletCode, normalizeWalletCode, sameWalletGroup } from './wallet-rules';

/**
 * Recepción exprés: se acerca el NFC (o se teclea el código) y la app sabe
 * sola si es nuevo o si ya tiene saldo, y cuánto. Solo lee.
 *  - NFC del stock, recién grabado o de un saldo ya cerrado → nuevo (se da
 *    a un saldo nuevo al cobrar: attachCard lo deja salir otra vez).
 *  - NFC de un saldo vivo (activo o a cero) → ese saldo (si se sumó a otro,
 *    aquel), con lo que tiene. En efectivo no sale nada: el saldo no se
 *    devuelve (saldo-rule.ts).
 *  - Perdido, bloqueado, copiado o de otro grupo de locales → error.
 * El código, igual que al recargar (topUpTarget): solo saldos activos.
 */

/**
 * Lo que «sale en efectivo» de un saldo: nada, y la regla en vez de la nota de
 * antes. Así una app del personal de antes no enseña «Devolver».
 */
export function noCashOut(balanceCents: number): Pick<ReceptionDeskSaldo, 'cashOutCents' | 'cashOutNote'> {
  return { cashOutCents: 0, cashOutNote: balanceCents > 0 ? SALDO_SE_QUEDA_TEXT : null };
}

/**
 * El NFC acercado o el código. El número impreso NO: se lee de la ficha y no
 * prueba que la tengan delante (FichaNumbersService enseña solo un resumen).
 */
export type DeskRef = { card: string; uid?: string | null } | { code: string };

export type DeskTx = Pick<TransactionalClient, 'walletCard' | 'clientWallet' | 'venue' | '$queryRaw' | 'walletPasskey'>;

/** Un saldo a cero (DEPLETED) se recarga y vuelve a estar activo: también vale. */
export const LIVE_WALLET_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'DEPLETED']);
const LIVE = LIVE_WALLET_STATUSES;
/** Saldos sumados uno a otro que se siguen como mucho (como topUpTarget). */
const MAX_MERGE_HOPS = 5;

const NOT_OURS = 'Este NFC no es de este local';

export interface DeskWallet {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  shortCode: string | null;
  balanceCents: number;
  status: string;
  pinHash: string | null;
  blockedAt: Date | null;
  closeRequestedAt: Date | null;
  mergedIntoId: string | null;
}

const WALLET_SELECT = {
  id: true,
  tenantId: true,
  walletGroup: true,
  shortCode: true,
  balanceCents: true,
  status: true,
  pinHash: true,
  blockedAt: true,
  closeRequestedAt: true,
  mergedIntoId: true,
} as const;

/** Lo que ve la recepción de un saldo vivo (función pura). */
export function deskSaldoView(
  wallet: Omit<DeskWallet, 'mergedIntoId' | 'walletGroup' | 'status'>,
  venueId: string,
  fichaNumber: number | null,
  printedNumber?: string | null,
  hasPasskey = false,
): ReceptionDeskSaldo {
  return {
    kind: 'saldo',
    walletId: wallet.id,
    code: formatWalletCode(wallet.shortCode ?? ''),
    balanceCents: wallet.balanceCents,
    hasPin: wallet.pinHash !== null,
    isHomeVenue: wallet.tenantId === venueId,
    blocked: wallet.blockedAt !== null,
    closeRequested: wallet.closeRequestedAt !== null,
    ...noCashOut(wallet.balanceCents),
    fichaNumber,
    ...(printedNumber ? { printedNumber } : {}),
    hasPasskey,
  };
}

/** El saldo donde está hoy el dinero (él mismo o aquel al que se sumó). */
export async function liveWallet(tx: Pick<DeskTx, 'clientWallet'>, walletId: string): Promise<DeskWallet | null> {
  let wallet = await tx.clientWallet.findUnique({ where: { id: walletId }, select: WALLET_SELECT });
  for (let hops = 0; wallet?.mergedIntoId && hops < MAX_MERGE_HOPS; hops += 1) {
    wallet = await tx.clientWallet.findUnique({ where: { id: wallet.mergedIntoId }, select: WALLET_SELECT });
  }
  return wallet;
}

/** El NFC acercado o el código tecleado → nuevo o el saldo (dentro de acrossVenues). */
export async function readReceptionDesk(
  tx: DeskTx,
  venue: { id: string; walletGroup: string | null },
  ref: DeskRef,
): Promise<ReceptionDeskView> {
  if ('code' in ref) return deskByCode(tx, venue, ref.code);
  if (!isWalletCardToken(ref.card)) throw new NotFoundException(NOT_OURS);
  const card = await tx.walletCard.findUnique({
    where: { token: ref.card },
    select: { id: true, uid: true, walletId: true, status: true, venueId: true, number: true, printedNumber: true },
  });
  if (!card || !(await cardInGroup(tx, card, venue.id))) throw new NotFoundException(NOT_OURS);
  const uid = ref.uid ? normalizeWalletCardUid(ref.uid) : null;
  if (card.uid && uid && card.uid !== uid) {
    throw new ConflictException('Este NFC no es el original (¿copiado?): avisa al encargado');
  }
  const unusable = cardUnusableText(card.status);
  if (unusable) throw new ConflictException(unusable);
  const wallet = isIssuedCard(card) && card.walletId ? await liveWallet(tx, card.walletId) : null;
  // Sin saldo, o el de un saldo ya cerrado (o de otro grupo): sale otra vez con uno nuevo.
  if (!wallet || !LIVE.has(wallet.status) || !sameWalletGroup(wallet, venue)) {
    return { kind: 'new', fichaNumber: card.number, ...(card.printedNumber ? { printedNumber: card.printedNumber } : {}) };
  }
  return deskSaldoView(wallet, venue.id, card.number, card.printedNumber, await hasPasskey(tx, wallet.id));
}

/** Tiene Face ID (paga desde su móvil). */
async function hasPasskey(tx: Pick<DeskTx, 'walletPasskey'>, walletId: string): Promise<boolean> {
  return (await tx.walletPasskey.count({ where: { walletId } })) > 0;
}

async function deskByCode(
  tx: DeskTx,
  venue: { id: string; walletGroup: string | null },
  raw: string,
): Promise<ReceptionDeskSaldo> {
  const code = normalizeWalletCode(raw);
  if (code.length !== 6) throw new NotFoundException('El código del cliente tiene 6 letras o números');
  const found = await tx.clientWallet.findFirst({ where: { shortCode: code, status: 'ACTIVE' }, select: { id: true } });
  const wallet = found ? await liveWallet(tx, found.id) : null;
  if (!wallet || !LIVE.has(wallet.status) || !sameWalletGroup(wallet, venue)) {
    throw new NotFoundException('No hay ningún saldo con ese código en este local');
  }
  const card = await tx.walletCard.findFirst({
    where: { walletId: wallet.id, status: { in: ISSUED_CARD_STATUSES } },
    orderBy: { linkedAt: { sort: 'desc', nulls: 'last' } },
    select: { number: true, printedNumber: true },
  });
  return deskSaldoView(wallet, venue.id, card?.number ?? null, card?.printedNumber, await hasPasskey(tx, wallet.id));
}
