// Deshacer una recarga en efectivo (estudio de fichas, B4): «Me he
// equivocado» de quien la cargó en los 2 minutos siguientes (con el motivo y
// la misma ficha) y, después, la anulación del encargado desde su móvil (con
// su 2FA). Las llamadas y los textos (probados en cash-undo.test.ts).

import {
  CASH_TOP_UP_UNDO_SECONDS,
  CASH_UNDO_REASON_LABEL,
  type CashTopUpUndoDto,
  type CashTopUpVoidResult,
  type CashUndoReason,
} from '@nightpay/contracts';
import { authedFetch, parseOperatorApiError } from './api';
import { formatEur } from './money';

export { CASH_UNDO_REASON_LABEL };
export type { CashUndoReason };

/** «Me he equivocado»: la misma persona, en 2 min, con el motivo y la misma ficha. */
export async function undoCashTopUp(topUpId: string, body: CashTopUpUndoDto): Promise<CashTopUpVoidResult> {
  const res = await authedFetch(`/v1/reception/cash/${encodeURIComponent(topUpId)}/undo`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recarga'));
  return res.json();
}

/** Una recarga en efectivo reciente del local, sin enseñar el saldo (GET /v1/reception/cash/recent). */
export interface RecentCash {
  id: string;
  at: string;
  /** null: la encargada con la noche abierta (cierre a ciegas), sin importes ni comisión. */
  amountCents: number | null;
  serviceFeeCents?: number;
  /** K7Q-•••. */
  codeHint: string;
  voided: boolean;
}

/** Lo que sale de la caja de una de la lista; a ciegas (null), sin cifras: se sabe al anular. */
export function recentCashOutCents(row: Pick<RecentCash, 'amountCents' | 'serviceFeeCents'>): number | null {
  return row.amountCents === null ? null : row.amountCents + (row.serviceFeeCents ?? 0);
}

/** Encargado o dueño: las de las últimas 2 h, que aún se pueden anular. */
export async function fetchRecentCash(): Promise<RecentCash[]> {
  const res = await authedFetch('/v1/reception/cash/recent');
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recargas'));
  return res.json();
}

/** Encargado o dueño: anular una, con el motivo y su 2FA (lo que sale de la caja: saldo + comisión). */
export async function voidCashTopUp(row: RecentCash, reason: CashUndoReason, totpCode: string): Promise<CashTopUpVoidResult> {
  const res = await authedFetch(`/v1/reception/cash/${encodeURIComponent(row.id)}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason: CASH_UNDO_REASON_LABEL[reason], totpCode, serviceFeeCents: row.serviceFeeCents }),
  });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Recarga'));
  return res.json();
}

/** ¿Aún se puede «Me he equivocado»? (`loadedAt`: cuándo salió CARGADO; en ms.) */
export function undoOpen(loadedAt: number, now: number): boolean {
  return now - loadedAt < CASH_TOP_UP_UNDO_SECONDS * 1000;
}

/** Debajo de cada motivo: qué pasa después. */
export const UNDO_REASON_NEXT: Readonly<Record<CashUndoReason, string>> = {
  amount: 'Se anula y la vuelves a cargar bien',
  ficha: 'Se anula y cargas la ficha buena',
  unpaid: 'Se anula: no hay efectivo',
};

/** Anulada: qué hacer ahora con el efectivo y la ficha. `cents`: lo que se quitó (saldo + comisión). */
export function undoneText(reason: CashUndoReason, cents: number): string {
  const amount = formatEur(cents, { compact: true });
  if (reason === 'amount') return `Se han quitado ${amount}. Vuelve a acercar su ficha y carga el importe bueno; si sobra efectivo, devuélveselo.`;
  if (reason === 'ficha') return `Se han quitado ${amount} de esa ficha. Acerca la ficha buena y cárgala con el efectivo que ya tienes.`;
  return `Se han quitado ${amount}. No pagó: no hay efectivo que devolver.`;
}
