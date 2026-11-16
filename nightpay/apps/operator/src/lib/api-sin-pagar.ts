// «Cobros» → «Sin pagar en el local»: los cobros sin pagar de todo el local
// (GET /payments/sin-pagar). Cualquiera del personal cancela cualquiera, también
// el de otra persona y con el cliente en su banco (pide confirmar). La recarga
// cobrada en el datáfono sin comprobar sale, pero no se cancela.

import { authedFetch, parseOperatorApiError } from './api';
import { formatEur } from './money';

export interface UnpaidCobro {
  id: string;
  ref: string | null;
  totalCents: number;
  status: 'CREATED' | 'AWAITING_CAPTURE' | 'AUTHORIZING';
  createdAt: string;
  createdByName: string;
  mine: boolean;
  atBank: boolean;
  bitcoin: boolean;
  /**
   * Recarga cobrada en el datáfono sin comprobar: la tarjeta ya pagó y la
   * resuelven en el panel; nadie del personal la cancela (el API dice 409).
   * Un API de antes no lo trae.
   */
  heldOnReader?: boolean;
}

/** Lo que se ve en la recarga cobrada en el datáfono sin comprobar (sin botón). */
export const HELD_ON_READER_TEXT = 'Cobrado en el datáfono, pendiente de comprobar';

export async function fetchUnpaidCobros(signal?: AbortSignal): Promise<UnpaidCobro[]> {
  const res = await authedFetch('/v1/payments/sin-pagar', { signal });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobros sin pagar'));
  const body = (await res.json()) as { items?: UnpaidCobro[] };
  return body.items ?? [];
}

/** Los que se enseñan: con los suyos ya en su lista (la chica los cancela ahí), solo los de otras personas. */
export function unpaidToShow(items: readonly UnpaidCobro[], ownListCancels: boolean): UnpaidCobro[] {
  return items.filter((u) => !(ownListCancels && u.mine));
}

/** ¿Lleva «Cancelar»? Todos, menos la recarga cobrada en el datáfono sin comprobar. */
export function unpaidCancelable(u: Pick<UnpaidCobro, 'heldOnReader'>): boolean {
  return !u.heldOnReader;
}

/** «C-0012 · 12 € · de Lucía» (o «· tuyo»): para reconocerlo y para «¿Cancelar este cobro?». */
export function unpaidLine(u: UnpaidCobro): string {
  return [u.ref, formatEur(u.totalCents, { compact: true }), u.mine ? 'tuyo' : `de ${u.createdByName}`].filter(Boolean).join(' · ');
}

/** En qué está: cobrado en el datáfono sin comprobar, el cliente en su banco, pagando con bitcoin, o esperando (QR o datáfono). */
export function unpaidState(u: UnpaidCobro): string {
  if (u.heldOnReader) return HELD_ON_READER_TEXT;
  if (u.bitcoin) return 'Pagando con bitcoin';
  if (u.atBank) return 'El cliente está en su banco';
  return 'Esperando el pago';
}
