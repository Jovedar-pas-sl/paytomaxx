// «Liquidaciones OxioPay» del panel del dueño (solo lectura, solo su local):
// /v1/admin/oxiopay-settlements. Lo de la consola va en endpoints/superadmin.

import type { OwnerSettlementNotice, OwnerSettlementPage, SettlementDetail } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

const BASE = '/v1/admin/oxiopay-settlements';
const id = (value: string): string => encodeURIComponent(value);

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await authedFetch(path, { signal });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as T;
}

export function fetchOwnerSettlements(signal?: AbortSignal): Promise<OwnerSettlementPage> {
  return json(BASE, signal);
}

export function fetchOwnerSettlement(settlementId: string, signal?: AbortSignal): Promise<SettlementDetail> {
  return json(`${BASE}/${id(settlementId)}`, signal);
}

/** Las que llevan más de 7 días sin pagar (el aviso de arriba del panel). */
export function fetchOwnerSettlementNotice(signal?: AbortSignal): Promise<OwnerSettlementNotice> {
  return json(`${BASE}/notice`, signal);
}

/** El documento (HTML para imprimir / guardar en PDF) o el CSV, como archivo. */
export async function downloadOwnerSettlement(settlementId: string, kind: 'document' | 'csv'): Promise<Blob> {
  const res = await authedFetch(`${BASE}/${id(settlementId)}/${kind}`);
  if (!res.ok) throw await apiError(res);
  return res.blob();
}
