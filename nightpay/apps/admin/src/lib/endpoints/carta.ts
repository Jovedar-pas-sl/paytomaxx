// Carta del local (Fase 1A; el mapa del dinero): servicios de todas las secciones y packs.

import type { PackComponent, SectionCode } from '@nightpay/contracts';
import { apiError, authedFetch } from '../http';

// ─── Carta de servicios ────────────────────────────────────────────

/** Sección de un servicio (los antiguos pueden tener EXTRA, «Otros»). */
export type RevenueCategory = SectionCode | 'EXTRA';

export interface ServiceItem {
  id: string;
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: RevenueCategory;
  active: boolean;
  sortOrder: number;
  /** Pack: sus partes (suman el precio). null = de una sola sección. */
  components?: PackComponent[] | null;
  /** «Invitar a una copa» (Copas): el camarero escanea el QR de la chica invitada. */
  isInvitation?: boolean;
}

export interface ServiceItemInput {
  name: string;
  durationMin: number | null;
  priceCents: number;
  category: SectionCode;
  sortOrder?: number;
  /** null = quitar el pack. */
  components?: PackComponent[] | null;
  /** Solo en Copas y sin pack. */
  isInvitation?: boolean;
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
