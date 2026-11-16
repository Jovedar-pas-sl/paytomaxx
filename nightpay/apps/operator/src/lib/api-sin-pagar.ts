// «Cobros» → «Sin pagar en el local»: los cobros sin pagar de todo el local
// (GET /payments/sin-pagar). Cualquiera del personal cancela cualquiera, también
// el de otra persona y con el cliente en su banco (pide confirmar).

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
}

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

/** «C-0012 · 12 € · de Lucía» (o «· tuyo»): para reconocerlo y para «¿Cancelar este cobro?». */
export function unpaidLine(u: UnpaidCobro): string {
  return [u.ref, formatEur(u.totalCents, { compact: true }), u.mine ? 'tuyo' : `de ${u.createdByName}`].filter(Boolean).join(' · ');
}

/** En qué está: el cliente en su banco, pagando con bitcoin, o esperando (QR o datáfono). */
export function unpaidState(u: UnpaidCobro): string {
  if (u.bitcoin) return 'Pagando con bitcoin';
  if (u.atBank) return 'El cliente está en su banco';
  return 'Esperando el pago';
}
