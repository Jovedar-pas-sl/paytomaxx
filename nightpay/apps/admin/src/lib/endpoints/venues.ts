// Locales (super-admin): lista y alta.

import { apiError, authedFetch } from '../http';

export interface VenueListItem {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: string;
}

export async function fetchAllVenues(): Promise<VenueListItem[]> {
  const res = await authedFetch('/v1/admin/venues');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function createVenue(input: {
  name: string;
  slug: string;
  timezone?: string;
}): Promise<VenueListItem> {
  const res = await authedFetch('/v1/admin/venues', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
