import { BadRequestException, ConflictException } from '@nestjs/common';
import { normalizePrintedFichaNumber } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * El número impreso de fábrica en el NFC (20261027100000). Se repite entre
 * lotes y entre locales: no se repite dentro de su sitio, fijado al numerar
 * la ficha: el grupo de locales («g:<grupo>»: las fichas pasan de un local a
 * otro del grupo) o, sin grupo, el local («v:<local>»). Se compara sin ceros
 * delante («00736903» = «736903») y se enseña tal cual se tecleó.
 */

export interface NumberVenue {
  id: string;
  walletGroup: string | null;
}

export const PRINTED_NUMBER_TAKEN = 'Ese número impreso ya lo tiene otra ficha de este local';
export const PRINTED_NUMBER_INVALID = 'El número impreso debe tener entre 1 y 12 cifras';

/** El sitio donde no se repite el número, al numerarla desde este local. */
export function printedScopeOf(venue: NumberVenue): string {
  return venue.walletGroup ? `g:${venue.walletGroup}` : `v:${venue.id}`;
}

/**
 * Dónde se busca desde este local: su grupo y él mismo (una ficha numerada
 * antes de que el local entrara en un grupo sigue apuntada a su local).
 */
export function printedLookupScopes(venue: NumberVenue): string[] {
  return venue.walletGroup ? [`g:${venue.walletGroup}`, `v:${venue.id}`] : [`v:${venue.id}`];
}

/**
 * Le pone el número (con la ficha ya bloqueada por quien llama). 409 si otra
 * ficha de su sitio ya lo tiene; el índice único lo para también si dos lo
 * ponen a la vez (P2002: isPrintedNumberClash).
 */
export async function assignPrintedNumber(
  tx: Pick<TransactionalClient, 'walletCard'>,
  venue: NumberVenue,
  cardId: string,
  printedNumber: string,
): Promise<void> {
  const norm = normalizePrintedFichaNumber(printedNumber);
  if (!norm) throw new BadRequestException(PRINTED_NUMBER_INVALID);
  const clash = await tx.walletCard.findFirst({
    where: { printedNumberNorm: norm, printedScope: { in: printedLookupScopes(venue) }, NOT: { id: cardId } },
    select: { id: true },
  });
  if (clash) throw new ConflictException(PRINTED_NUMBER_TAKEN);
  await tx.walletCard.update({
    where: { id: cardId },
    data: { printedNumber, printedNumberNorm: norm, printedScope: printedScopeOf(venue) },
  });
}

/** El mismo número a la vez en dos fichas de su sitio (el índice único). */
export function isPrintedNumberClash(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'P2002';
}
