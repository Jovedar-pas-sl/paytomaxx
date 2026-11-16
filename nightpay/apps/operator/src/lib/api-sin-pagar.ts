// «Cobros» → «Sin pagar en el local»: los cobros sin pagar de todo el local
// (GET /payments/sin-pagar). Cualquiera del personal cancela cualquiera, también
// el de otra persona (pide confirmar); con el cliente en su banco, pasados 2
// minutos (cancel-at-bank.ts).

import { authedFetch, parseOperatorApiError } from './api';
import { AT_BANK_PAYING_TEXT, AT_BANK_SLOW_TEXT, type BankCancel } from './cancel-at-bank';
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
  /** En su banco: desde cuándo (hora del servidor). Un API de antes no lo trae. */
  atBankSince?: string | null;
  /** En su banco: lo que faltaba para poder cancelar al responder (ms; 0 = ya). Un API de antes no lo trae. */
  cancelableInMs?: number;
}

/** Con la hora (en el reloj de este móvil) desde la que se puede cancelar: null fuera del banco. */
export type UnpaidRow = UnpaidCobro & { cancelableAtMs: number | null };

export async function fetchUnpaidCobros(signal?: AbortSignal): Promise<UnpaidCobro[]> {
  const res = await authedFetch('/v1/payments/sin-pagar', { signal });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Cobros sin pagar'));
  const body = (await res.json()) as { items?: UnpaidCobro[] };
  return body.items ?? [];
}

/** Los que se enseñan: con los suyos ya en su lista (la chica los cancela ahí), solo los de otras personas. */
export function unpaidToShow<T extends UnpaidCobro>(items: readonly T[], ownListCancels: boolean): T[] {
  return items.filter((u) => !(ownListCancels && u.mine));
}

/** «C-0012 · 12 € · de Lucía» (o «· tuyo»): para reconocerlo y para «¿Cancelar este cobro?». */
export function unpaidLine(u: UnpaidCobro): string {
  return [u.ref, formatEur(u.totalCents, { compact: true }), u.mine ? 'tuyo' : `de ${u.createdByName}`].filter(Boolean).join(' · ');
}

/**
 * En qué está: pagando con bitcoin, esperando (QR o datáfono) o en su banco:
 * los primeros 2 minutos «El cliente está pagando en su banco» (sin botón) y
 * después «El banco tarda…» (con el botón).
 */
export function unpaidState(u: UnpaidCobro, bank: BankCancel = 'wait'): string {
  if (u.bitcoin) return 'Pagando con bitcoin';
  if (u.atBank) return bank === 'late' ? AT_BANK_SLOW_TEXT : AT_BANK_PAYING_TEXT;
  return 'Esperando el pago';
}
