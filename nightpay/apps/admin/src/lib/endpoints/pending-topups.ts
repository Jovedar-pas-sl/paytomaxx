// Recargas pendientes de asignar: cobradas sin el NFC del cliente (Inicio →
// «Recargar saldo», plan B). Desde el panel se asignan con su código.

import type { AssignedTopUp, PendingTopUpView } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

export async function fetchPendingTopUps(): Promise<PendingTopUpView[]> {
  const res = await authedFetch('/v1/reception/topups/pending');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Se suma al saldo del cliente (su código, K7Q-4M2). */
export async function assignPendingTopUp(walletId: string, code: string): Promise<AssignedTopUp> {
  const res = await authedFetch(`/v1/reception/topups/${encodeURIComponent(walletId)}/assign`, {
    method: 'POST',
    body: JSON.stringify({ code: code.trim() }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
