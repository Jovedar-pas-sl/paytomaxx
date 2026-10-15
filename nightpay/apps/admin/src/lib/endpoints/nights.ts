// Noches e informe Z (Fase 1D).

import { apiError, authedFetch } from '../http';

// ─── Noches (Fase 1D) ──────────────────────────────────────────────

export interface NightSummary {
  count: number;
  grossCents: number;
  tipsCents: number;
  chargedCents: number;
  refundsCount: number;
  refundsCents: number;
  netCents: number;
  byType: Array<{ label: string; count: number; chargedCents: number }>;
  chicaCommissionCents: number;
  chicaTipsCents: number;
  chicaReversalsCents: number;
  chicaNetCents: number;
  venueTipsCents: number;
  venueNetCents: number;
  payoutsCount: number;
  payoutsCents: number;
  perChica: Array<{
    name: string;
    count: number;
    chargedCents: number;
    commissionCents: number;
    tipsCents: number;
    reversalsCents: number;
    netCents: number;
    paidCents: number;
  }>;
  // API nuevo (los Z congelados antes no los traen):
  /** Saldo devuelto al cliente en efectivo: resta del neto. */
  walletCashPayoutsCents?: number;
  /** Saldo devuelto a la tarjeta: ya está en las devoluciones (solo se informa). */
  walletCardPayoutsCents?: number;
  /** Consumos del saldo (ventas, no dinero nuevo). */
  consumptionsCount?: number;
  consumptionsCents?: number;
  saldoByType?: Array<{ label: string; count: number; chargedCents: number }>;
}

/** Lo apuntado tarde con fecha de noches ya cerradas: va en el Z siguiente. */
export interface NightAdjustments {
  since: string;
  before: string;
  count: number;
  summary: NightSummary;
  reversedConsumptionsCount: number;
  reversedConsumptionsCents: number;
  reversedConsumptionsChicaCents: number;
}

export interface NightZ {
  from: string;
  to: string;
  generatedAt: string;
  summary: NightSummary;
  pendingCount: number;
  /** API nuevo: ajustes de noches anteriores. */
  adjustments?: NightAdjustments;
}

export interface NightView {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  closeNote: string | null;
  z: NightZ;
  pending: Array<{ id: string; status: string; amountCents: number; createdAt: string; captureMethod: string | null }>;
}

export interface NightListItem {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  count: number | null;
  chargedCents: number | null;
  netCents: number | null;
}

export async function fetchCurrentNight(): Promise<NightView | null> {
  const res = await authedFetch('/v1/nights/current');
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { night: NightView | null }).night;
}

export async function openNight(): Promise<NightView> {
  const res = await authedFetch('/v1/nights/open', { method: 'POST', body: '{}' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function closeNight(id: string, input: { force?: boolean; note?: string }): Promise<NightView> {
  const res = await authedFetch(`/v1/nights/${id}/close`, { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchNights(): Promise<NightListItem[]> {
  const res = await authedFetch('/v1/nights');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchNight(id: string): Promise<NightView> {
  const res = await authedFetch(`/v1/nights/${id}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}
