'use client';

import { createContext, useContext } from 'react';
import { DEFAULT_TIMEZONE } from './dates';

/** Local activo del panel: su nombre (para verlo siempre) y su zona horaria (para las horas). */
export interface VenueInfo {
  /** null mientras no se sabe (se enseña el slug). */
  name: string | null;
  slug: string;
  timezone: string;
}

export const VenueContext = createContext<VenueInfo>({ name: null, slug: '', timezone: DEFAULT_TIMEZONE });

export function useVenue(): VenueInfo {
  return useContext(VenueContext);
}

/** Zona horaria del local para formatDateTime (Madrid si no se sabe). */
export function useVenueTimezone(): string {
  return useContext(VenueContext).timezone;
}
