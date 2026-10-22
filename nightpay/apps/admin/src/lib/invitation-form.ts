// Ajustes → Invitaciones (lógica pura): la parte de la chica de cada «Copa con
// invitación» tal como se teclea (% o € por copa), el ejemplo que ve el dueño
// y, fuera del camino, la parte del camarero (de fábrica, nada: el local se
// queda lo que no es de la chica).

import { invitationShares, isZeroShare, parseEuroCents, type InvitationRules, type InvitationShare } from '@nightpay/contracts';
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

/** El reparto de referencia: la mitad para la chica y el resto, del local (el camarero, nada). */
export const REFERENCE_SPLIT: Readonly<{ chica: ShareDraft; camarero: ShareDraft }> = {
  chica: { kind: 'PERCENT', value: '50' },
  camarero: { kind: 'PERCENT', value: '0' },
};

/**
 * ¿Enseñar abierta la parte del camarero? Solo si el local le da algo (una
 * parte guardada antes): de fábrica va cerrada, fuera del camino. Mientras se
 * teclea (vacío o a medias) no se cierra.
 */
export function showCamareroShare(d: ShareDraft): boolean {
  const parsed = shareFromDraft(d, 'el camarero');
  return !parsed.ok || !isZeroShare(parsed.share);
}

/**
 * «De una copa con invitación de 20 €: 10 € para la chica y 10 € para el
 * local.» Con parte para el camarero (si el local se la da), también la suya.
 */
export function invitationExample(rules: InvitationRules, priceCents: number): string {
  const { beneficiaryCents, chargerCents } = invitationShares(rules, { unitCents: priceCents, qty: 1 }, { getsShare: true });
  const local = priceCents - beneficiaryCents - chargerCents;
  const head = `De una copa con invitación de ${formatEur(priceCents)}: ${formatEur(beneficiaryCents)} para la chica`;
  if (chargerCents === 0) return `${head} y ${formatEur(local)} para el local.`;
  return `${head}, ${formatEur(chargerCents)} para el camarero que la cobra y ${formatEur(local)} para el local.`;
}
