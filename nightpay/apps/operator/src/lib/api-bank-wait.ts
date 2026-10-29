// La pantalla «El banco no lo ha confirmado» de Esperando (cobro ORPHAN): su
// referencia y «Avisar al encargado». Aparte de api-cobro.ts para no mezclar
// con el cobro del saldo.

import { authedFetch, operatorApiError } from './api';

/** Referencia corta del cobro (C-0012) y pedido del banco del último intento (para buscarlo en el portal). */
export interface BankRef {
  ref: string | null;
  order: string | null;
}

export async function fetchBankRef(paymentId: string, signal?: AbortSignal): Promise<BankRef> {
  const res = await authedFetch(`/v1/payments/${encodeURIComponent(paymentId)}/bank-ref`, { signal });
  if (!res.ok) throw await operatorApiError(res, 'Referencia del cobro');
  return res.json();
}

/**
 * «Avisar al encargado»: la incidencia del cobro (ya en Incidencias del panel)
 * le llega ahora por Telegram. `notified`: le ha llegado; `telegram`: el local
 * tiene los avisos encendidos (si no, lo ve en el panel).
 */
export async function notifyManager(paymentId: string): Promise<{ notified: boolean; telegram: boolean }> {
  const res = await authedFetch('/v1/incidents/notify', { method: 'POST', body: JSON.stringify({ paymentId }) });
  if (!res.ok) throw await operatorApiError(res, 'Aviso al encargado');
  return res.json();
}

/** Lo que se dice tras avisar. */
export function notifiedText(r: { notified: boolean; telegram: boolean }): string {
  if (r.notified) return 'Avisado: al encargado le ha llegado el aviso. Espera a que lo mire en el banco.';
  return 'Ya está en Incidencias del panel: el encargado lo ve allí. Díselo también de palabra.';
}
