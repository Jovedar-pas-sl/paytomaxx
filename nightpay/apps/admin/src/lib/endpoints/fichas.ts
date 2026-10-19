// Fichas NFC del local (Clientes → Fichas): stock, entregadas, perdidas.

import type { FichasSummary, WalletCardRow, WalletCardStatus } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

export type { FichasNight, FichasSummary, WalletCardRow, WalletCardStatus } from '@nightpay/contracts';

/** La lista de fichas del local; `q` busca por número de serie, código del saldo o el código grabado. */
export async function fetchFichas(input: { q?: string; status?: WalletCardStatus | '' } = {}): Promise<WalletCardRow[]> {
  const params = new URLSearchParams();
  if (input.q?.trim()) params.set('q', input.q.trim());
  if (input.status) params.set('status', input.status);
  const qs = params.toString();
  const res = await authedFetch(`/v1/wallet-cards${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** En stock, entregadas y lo de cada noche. */
export async function fetchFichasSummary(): Promise<FichasSummary> {
  const res = await authedFetch('/v1/wallet-cards/summary');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Bloquear la ficha (ya no paga) o marcarla perdida (además sale del stock). */
export async function markFicha(id: string, action: 'block' | 'lost'): Promise<WalletCardRow> {
  const res = await authedFetch(`/v1/wallet-cards/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
