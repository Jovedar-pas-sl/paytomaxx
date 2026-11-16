// «Cobros» → «Sin pagar en el local»: los cobros sin pagar de todo el local
// (GET /payments/sin-pagar). Cualquiera del personal cancela cualquiera, también
// el de otra persona (pide confirmar); con el cliente en su banco, pasados 2
// minutos (cancel-at-bank.ts). La recarga cobrada en el datáfono sin comprobar
// sale, pero no se cancela.

import { authedFetch, parseOperatorApiError } from './api';
import { AT_BANK_PAYING_TEXT, AT_BANK_SLOW_TEXT, HELD_ON_READER_TEXT, bankCancel, type BankCancel } from './cancel-at-bank';
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
  /**
   * Recarga cobrada en el datáfono sin comprobar: la tarjeta ya pagó y la
   * resuelven en el panel; nadie del personal la cancela (el API dice 409).
   * Un API de antes no lo trae.
   */
  heldOnReader?: boolean;
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

/** ¿Se puede cancelar alguna vez? Todos, menos la recarga cobrada en el datáfono sin comprobar. */
export function unpaidCancelable(u: Pick<UnpaidCobro, 'heldOnReader'>): boolean {
  return !u.heldOnReader;
}

/**
 * Qué ofrece «Cancelar» en una fila de «Sin pagar» con el reloj de la pantalla:
 * la recarga cobrada en el datáfono sin comprobar, nunca ('held'); en su banco,
 * los primeros 2 minutos no ('wait').
 */
export function unpaidBank(u: Pick<UnpaidRow, 'atBank' | 'cancelableAtMs' | 'heldOnReader'>, nowMs: number): BankCancel {
  return bankCancel(u.atBank, u.cancelableAtMs, nowMs, !unpaidCancelable(u));
}

/** «C-0012 · 12 € · de Lucía» (o «· tuyo»): para reconocerlo y para «¿Cancelar este cobro?». */
export function unpaidLine(u: UnpaidCobro): string {
  return [u.ref, formatEur(u.totalCents, { compact: true }), u.mine ? 'tuyo' : `de ${u.createdByName}`].filter(Boolean).join(' · ');
}

/**
 * En qué está: cobrado en el datáfono sin comprobar (sin botón, nunca), pagando
 * con bitcoin, esperando (QR o datáfono) o en su banco: los primeros 2 minutos
 * «El cliente está pagando en su banco» (sin botón) y después «El banco tarda…»
 * (con el botón).
 */
export function unpaidState(u: UnpaidCobro, bank: BankCancel = 'wait'): string {
  if (u.heldOnReader) return HELD_ON_READER_TEXT;
  if (u.bitcoin) return 'Pagando con bitcoin';
  if (u.atBank) return bank === 'late' ? AT_BANK_SLOW_TEXT : AT_BANK_PAYING_TEXT;
  return 'Esperando el pago';
}
