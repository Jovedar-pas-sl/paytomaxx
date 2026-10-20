'use client';

// Secciones del local (Ajustes → Secciones): nombre y color de cada una. Se
// piden una vez al entrar en el panel; mientras, las de fábrica.

import { createContext, useContext, useEffect, useState } from 'react';
import type { VenueSection } from '@nightpay/contracts';
import { fetchSections } from './api';
import { FALLBACK_SECTIONS } from './money-map';

export interface SectionsState {
  sections: VenueSection[];
  /** Tras guardarlas en Ajustes: todo el panel con las nuevas. */
  replace: (next: VenueSection[]) => void;
}

export const SectionsContext = createContext<SectionsState>({ sections: FALLBACK_SECTIONS, replace: () => undefined });

export function useSections(): SectionsState {
  return useContext(SectionsContext);
}

export function useSectionsFeed(tenantId: string): SectionsState {
  const [sections, setSections] = useState<VenueSection[]>(FALLBACK_SECTIONS);
  useEffect(() => {
    let cancelled = false;
    fetchSections()
      .then((s) => {
        if (!cancelled) setSections(s);
      })
      .catch(() => {
        // Sin respuesta: las de fábrica (solo cambian nombres y colores).
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);
  return { sections, replace: setSections };
}
