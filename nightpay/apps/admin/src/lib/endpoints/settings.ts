// Ajustes del local.

import { apiError, authedFetch } from '../http';

// ─── Venue settings (Ajustes) ──────────────────────────────────────

export interface OperatorCommissionDefaults {
  CHICA_SERVICE: number;
  VENUE_BAR: number;
  VENUE_ROOM: number;
  VENUE_FOOD: number;
  EXTRA: number;
}

export interface VenueSettings {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  operatorMaxCobroCents: number;
  platformCommissionBps: number;
  operatorCommissionDefaults: OperatorCommissionDefaults;
}

export async function fetchVenueSettings(): Promise<VenueSettings> {
  const res = await authedFetch('/v1/admin/venue/settings');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * El PATCH solo devuelve lo editable (sin nombre, slug ni zona horaria): quien
 * llama lo mezcla con lo que ya tenía.
 */
export async function updateVenueSettings(input: {
  operatorMaxCobroCents?: number;
  platformCommissionBps?: number;
  operatorCommissionDefaults?: Partial<OperatorCommissionDefaults>;
}): Promise<
  Pick<VenueSettings, 'id' | 'operatorMaxCobroCents' | 'platformCommissionBps' | 'operatorCommissionDefaults'>
> {
  const res = await authedFetch('/v1/admin/venue/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
