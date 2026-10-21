import type { OwnCobro, OwnCobrosPage } from '@nightpay/contracts';
import { authedFetch } from './api';

export async function fetchOwnCobros(cursor?: string, signal?: AbortSignal): Promise<OwnCobrosPage> {
  const q = new URLSearchParams({ limit: '50' });
  if (cursor) q.set('cursor', cursor);
  const res = await authedFetch(`/v1/staff/me/cobros?${q}`, { signal });
  if (!res.ok) throw new Error('No se pudo cargar tu historial de cobros. Vuelve a intentarlo.');
  return res.json();
}

/** Conserva páginas anteriores y actualiza los estados que ya estaban visibles. */
export function mergeOwnCobros(previous: readonly OwnCobro[], fresh: readonly OwnCobro[]): OwnCobro[] {
  const items = new Map(previous.map((r) => [`${r.kind}:${r.id}`, r]));
  for (const row of fresh) items.set(`${row.kind}:${row.id}`, row);
  return [...items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

const STATUS: Readonly<Record<string, string>> = {
  CREATED: 'Pendiente', AWAITING_CAPTURE: 'Pendiente', AUTHORIZING: 'Pagando', AUTHORIZED: 'Cobrado', ACCEPTED: 'Cobrado',
  PARTIALLY_REFUNDED: 'Devuelto parcialmente', REFUNDED: 'Devuelto', REVERSED: 'Anulado', CANCELED: 'Cancelado',
  EXPIRED: 'Caducado', FAILED: 'Fallido', DECLINED: 'Rechazado',
};
export const ownCobroStatus = (status: string): string => STATUS[status] ?? status;
