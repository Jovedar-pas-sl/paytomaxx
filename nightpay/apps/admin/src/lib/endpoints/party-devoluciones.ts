// OxioParty · Devoluciones de «Lo que sobra» (EDITION=party): la lista con
// los totales, «Hecha», anular y las transferencias pendientes en CSV o en
// un fichero SEPA para el banco. Dueño y encargado.

import type { PartyRefundList, PartyRefundMethod, PartyRefundRow, PartyRefundStatus } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

export type { PartyRefundList, PartyRefundMethod, PartyRefundRow, PartyRefundStatus, PartyRefundTotals } from '@nightpay/contracts';

const BASE = '/v1/admin/party/refunds';

export async function fetchPartyRefunds(
  input: { status?: PartyRefundStatus | ''; method?: PartyRefundMethod | '' } = {},
  signal?: AbortSignal,
): Promise<PartyRefundList> {
  const params = new URLSearchParams();
  if (input.status) params.set('status', input.status);
  if (input.method) params.set('method', input.method);
  const qs = params.toString();
  const res = await authedFetch(`${BASE}${qs ? `?${qs}` : ''}`, { signal });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** «Hecha»: la tarjeta ya devuelta en el banco, o la transferencia enviada. */
export async function markPartyRefundDone(id: string): Promise<PartyRefundRow> {
  const res = await authedFetch(`${BASE}/${encodeURIComponent(id)}/done`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Anularla: no sale nada y el saldo vuelve a poder gastarse. */
export async function cancelPartyRefund(id: string): Promise<PartyRefundRow> {
  const res = await authedFetch(`${BASE}/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Las transferencias pendientes en CSV (con el IBAN entero, para hacerlas a mano). */
export async function downloadTransfersCsv(): Promise<Blob> {
  const res = await authedFetch(`${BASE}/transferencias.csv`);
  if (!res.ok) throw await apiError(res);
  return res.blob();
}

/**
 * Las mismas en un fichero SEPA (pain.001.001.03) para subirlas al banco de
 * una vez, desde la cuenta del local. Sin esa cuenta, 409 NO_DEBTOR_IBAN
 * (el mensaje del API lo dice). Queda en el registro.
 */
export async function downloadTransfersSepa(): Promise<Blob> {
  const res = await authedFetch(`${BASE}/transferencias.sepa`);
  if (!res.ok) throw await apiError(res);
  return res.blob();
}
