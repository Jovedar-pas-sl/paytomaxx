// «Ficha perdida» en recepción (estudio de fichas, B6): la llamada y lo que
// se dice antes de confirmar (probado en lost-ficha.test.ts).

import type { ReplaceLostFichaDto, ReplacedFicha } from '@nightpay/contracts';
import { authedFetch, parseOperatorApiError } from './api';
import { formatEur } from './money';

/** Ficha nueva para un saldo que ya tenía: la vieja deja de pagar y la nueva se cobra del saldo. */
export async function replaceLostFicha(body: ReplaceLostFichaDto): Promise<ReplacedFicha> {
  const res = await authedFetch('/v1/reception/fichas/replace-lost', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}

/**
 * Antes de confirmar: cuánto cuesta y cuánto le quedará; o, si no le llega,
 * por qué no se hace (sin botón).
 */
export function lostFichaPlan(balanceCents: number, feeCents: number): { ok: boolean; text: string } {
  const eur = (cents: number) => formatEur(cents, { compact: true });
  if (balanceCents < feeCents) {
    return { ok: false, text: `No le llega el saldo: le quedan ${eur(balanceCents)} y la ficha nueva cuesta ${eur(feeCents)}. Que cargue antes.` };
  }
  if (feeCents <= 0) return { ok: true, text: 'La ficha nueva no le cuesta nada. La vieja deja de pagar en cuanto acerques la nueva.' };
  return {
    ok: true,
    text: `La ficha nueva cuesta ${eur(feeCents)} de su saldo: le quedan ${eur(balanceCents)} y le quedarán ${eur(balanceCents - feeCents)}. La vieja deja de pagar en cuanto acerques la nueva.`,
  };
}
