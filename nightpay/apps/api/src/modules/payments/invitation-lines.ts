import { invitationShares, type InvitationRules } from '@nightpay/contracts';
import type { CartaItemLike, DraftLine } from './charge-lines';

/**
 * «Copa con invitación» (lógica pura): las líneas de una invitación de la
 * carta llevan a la chica invitada y lo que les toca a ella y a quien cobra,
 * fijado al cobrar (si el dueño cambia las partes luego, no cambia lo ya
 * cobrado). El resto de la línea es del local.
 */

/** ¿Lleva el cobro alguna invitación de la carta? */
export function isInvitationLine(line: Pick<DraftLine, 'serviceItemId'>, items: ReadonlyMap<string, CartaItemLike>): boolean {
  return Boolean(line.serviceItemId && items.get(line.serviceItemId)?.isInvitation);
}

export function withInvitation(
  lines: readonly DraftLine[],
  items: ReadonlyMap<string, CartaItemLike>,
  invite: { beneficiaryOperatorId: string; rules: InvitationRules; chargerGetsShare: boolean },
): DraftLine[] {
  return lines.map((l) => {
    if (!isInvitationLine(l, items)) return l;
    const shares = invitationShares(invite.rules, l, { getsShare: invite.chargerGetsShare });
    return { ...l, beneficiaryOperatorId: invite.beneficiaryOperatorId, ...shares };
  });
}

/**
 * Las ganancias de las invitaciones de un cobro: una por chica invitada (su
 * parte de todas sus líneas) y, si le toca algo, una para quien cobró.
 * `bps` es el efectivo sobre lo vendido, para enseñar «50 % de 20 €».
 */
export interface InvitationEarning {
  operatorId: string;
  commissionCents: number;
  paymentAmountCents: number;
  commissionBps: number;
  paymentLineId: string;
}

export function invitationEarnings(
  lines: ReadonlyArray<{
    id: string;
    amountCents: number;
    beneficiaryOperatorId: string | null;
    beneficiaryCents: number | null;
    chargerCents: number | null;
  }>,
  chargerId: string | null,
): InvitationEarning[] {
  const acc = new Map<string, InvitationEarning>();
  const add = (operatorId: string, cents: number, amount: number, lineId: string) => {
    const cur = acc.get(operatorId) ?? { operatorId, commissionCents: 0, paymentAmountCents: 0, commissionBps: 0, paymentLineId: lineId };
    acc.set(operatorId, { ...cur, commissionCents: cur.commissionCents + cents, paymentAmountCents: cur.paymentAmountCents + amount });
  };
  for (const l of lines) {
    if (!l.beneficiaryOperatorId) continue;
    if ((l.beneficiaryCents ?? 0) > 0) add(l.beneficiaryOperatorId, l.beneficiaryCents ?? 0, l.amountCents, l.id);
    if (chargerId && (l.chargerCents ?? 0) > 0) add(chargerId, l.chargerCents ?? 0, l.amountCents, l.id);
  }
  return [...acc.values()].map((e) => ({
    ...e,
    commissionBps: e.paymentAmountCents > 0 ? Math.round((e.commissionCents * 10_000) / e.paymentAmountCents) : 0,
  }));
}
