'use client';

// Secciones del local en la app (el mapa del dinero): «Otro importe» pide la
// sección con botones de su color, con la del puesto de quien cobra ya
// marcada. Se piden una vez por sesión (/v1/venues/me); si no llegan, las de
// fábrica (el servidor decide igual por el puesto).

import { useEffect, useState } from 'react';
import { DEFAULT_SECTIONS, SECTION_CODES, sectionMeta, type SectionCode, type VenueSection } from '@nightpay/contracts';
import { fetchMySections, getUser, type MySections } from './api';

export const FALLBACK_SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));

/** Las que se ofrecen: encendidas (y nunca ninguna: entonces, las de fábrica). */
export function offeredSections(all: readonly VenueSection[]): VenueSection[] {
  const on = all.filter((s) => s.enabled);
  return on.length > 0 ? on : FALLBACK_SECTIONS;
}

/** La sección marcada al empezar: la del puesto si se ofrece; si no, la primera. */
export function initialSection(offered: readonly VenueSection[], preferred: SectionCode | null): SectionCode {
  if (preferred && offered.some((s) => s.code === preferred)) return preferred;
  return offered[0]?.code ?? 'VENUE_BAR';
}

/** «Copas», «Varias» o nada: de qué sección es lo que se cobró (el PAGADO lo enseña con su referencia). */
export function chargeSectionLabel(
  lines: ReadonlyArray<{ category: string }> | undefined,
  sections: readonly VenueSection[],
): string | null {
  const codes = [...new Set((lines ?? []).map((l) => l.category))];
  if (codes.length === 0) return null;
  if (codes.length > 1) return 'Varias';
  return sectionMeta(sections, codes[0]!).label;
}

let cache: { userId: string; promise: Promise<MySections> } | null = null;

function load(): Promise<MySections> {
  const userId = getUser()?.id ?? '';
  if (!cache || cache.userId !== userId) {
    cache = { userId, promise: fetchMySections() };
    // Si falla, que la próxima pantalla lo vuelva a pedir.
    cache.promise.catch(() => {
      cache = null;
    });
  }
  return cache.promise;
}

export interface MySectionsState {
  sections: VenueSection[];
  defaultCategory: SectionCode | null;
}

export function useMySections(): MySectionsState {
  const [state, setState] = useState<MySectionsState>({ sections: FALLBACK_SECTIONS, defaultCategory: null });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((s) => {
        if (!cancelled) setState({ sections: s.sections.length > 0 ? s.sections : FALLBACK_SECTIONS, defaultCategory: s.defaultCategory });
      })
      .catch(() => {
        // Sin respuesta: las de fábrica; el servidor pone la del puesto si hace falta.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** Color de la sección de un servicio de la carta (borde de su botón). */
export function sectionColor(sections: readonly VenueSection[], code: string): string {
  return sectionMeta(sections, code).color;
}
