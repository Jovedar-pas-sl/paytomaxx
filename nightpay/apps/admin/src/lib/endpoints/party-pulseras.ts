// OxioParty · Pulseras (EDITION=party): recuento, buscador, preparar en lote,
// hoja para imprimir y sustituir la perdida. Dueño y encargado.

import type { PreparedPulseras, PulserasView, ReplacedPulsera, WalletCardRow, WalletCardStatus } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

export type { PreparedPulseras, PulseraCounts, PulseraRow, PulserasView, ReplacedPulsera } from '@nightpay/contracts';

const BASE = '/v1/admin/party/pulseras';

/** El recuento por estado y la lista (como mucho 100; `q`: «P-0412», «412» o el código del saldo). */
export async function fetchPulseras(input: { q?: string; status?: WalletCardStatus | '' } = {}, signal?: AbortSignal): Promise<PulserasView> {
  const params = new URLSearchParams();
  if (input.q?.trim()) params.set('q', input.q.trim());
  if (input.status) params.set('status', input.status);
  const qs = params.toString();
  const res = await authedFetch(`${BASE}${qs ? `?${qs}` : ''}`, { signal });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** N pulseras nuevas al stock, de una vez. */
export async function preparePulseras(count: number): Promise<PreparedPulseras> {
  const res = await authedFetch(`${BASE}/lote`, { method: 'POST', body: JSON.stringify({ count }) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** La hoja para imprimir (HTML con el número y el QR de cada una), de un número a otro. */
export async function downloadPulseraSheet(desde: number, hasta: number): Promise<Blob> {
  const params = new URLSearchParams({ desde: String(desde), hasta: String(hasta) });
  const res = await authedFetch(`${BASE}/hoja?${params.toString()}`, {}, { timeoutMs: 60_000 });
  if (!res.ok) throw await apiError(res);
  return res.blob();
}

/** Perdida: se bloquea y su saldo pasa a la nueva (su número). */
export async function replacePulsera(id: string, nueva: string): Promise<ReplacedPulsera> {
  const res = await authedFetch(`${BASE}/${encodeURIComponent(id)}/sustituir`, { method: 'POST', body: JSON.stringify({ nueva }) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Bloquearla sin más (ya no paga; el saldo sigue): lo de siempre de las fichas. */
export async function blockPulsera(id: string): Promise<WalletCardRow> {
  const res = await authedFetch(`/v1/wallet-cards/${encodeURIComponent(id)}/block`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
