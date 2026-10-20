// Ajustes → Invitaciones (lógica pura): la parte de la chica y la del camarero
// tal como se teclean (% o € por copa) y el ejemplo que ve el dueño.

import { invitationShares, parseEuroCents, type InvitationRules, type InvitationShare } from '@nightpay/contracts';
import { centsToInput, formatEur } from './money';

export interface ShareDraft {
  kind: InvitationShare['kind'];
  value: string;
}

export function shareToDraft(s: InvitationShare): ShareDraft {
  if (s.kind === 'PERCENT') return { kind: 'PERCENT', value: String(s.bps / 100).replace('.', ',') };
  return { kind: 'FIXED', value: centsToInput(s.cents) };
}

const ZERO = /^0+(?:[.,]0+)?$/;

/** Lo tecleado → la parte, o el problema (en español). */
export function shareFromDraft(d: ShareDraft, who: string): { ok: true; share: InvitationShare } | { ok: false; problem: string } {
  const text = d.value.trim().replace(/[\s%€]/g, '');
  if (d.kind === 'PERCENT') {
    const pct = /^\d{1,3}(?:[.,]\d{1,2})?$/.test(text) ? Number(text.replace(',', '.')) : NaN;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, problem: `La parte de ${who} es un % entre 0 y 100.` };
    return { ok: true, share: { kind: 'PERCENT', bps: Math.round(pct * 100) } };
  }
  const cents = ZERO.test(text) ? 0 : parseEuroCents(text);
  if (cents === null) return { ok: false, problem: `Pon cuántos € por copa son para ${who} (o 0).` };
  return { ok: true, share: { kind: 'FIXED', cents } };
}

/** «De una invitación de 20 €: 10 € para la chica, 0 € para el camarero y 10 € para el local.» */
export function invitationExample(rules: InvitationRules, priceCents: number): string {
  const { beneficiaryCents, chargerCents } = invitationShares(rules, { unitCents: priceCents, qty: 1 }, { getsShare: true });
  const local = priceCents - beneficiaryCents - chargerCents;
  return (
    `De una invitación de ${formatEur(priceCents)}: ${formatEur(beneficiaryCents)} para la chica, ` +
    `${formatEur(chargerCents)} para el camarero y ${formatEur(local)} para el local.`
  );
}
