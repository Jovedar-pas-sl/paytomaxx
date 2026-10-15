// Carta de servicios (Fase 1A).

import { apiError, authedFetch } from '../http';

// ─── Fase 1A — Carta de servicios ──────────────────────────────────

export type RevenueCategory = 'CHICA_SERVICE' | 'VENUE_BAR' | 'VENUE_ROOM' | 'VENUE_FOOD' | 'EXTRA';

export interface ServiceItem {
  id: string;
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: RevenueCategory;
  active: boolean;
  sortOrder: number;
}

export interface ServiceItemInput {
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: RevenueCategory;
  sortOrder?: number;
}

export async function fetchCarta(): Promise<ServiceItem[]> {
  const res = await authedFetch('/v1/services/all');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function createServiceItem(input: ServiceItemInput): Promise<ServiceItem> {
  const res = await authedFetch('/v1/services', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateServiceItem(
  id: string,
  input: Partial<ServiceItemInput> & { active?: boolean },
): Promise<ServiceItem> {
  const res = await authedFetch(`/v1/services/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
