'use client';

// Secciones del local en la app (el mapa del dinero): «Otro importe» pide la
// sección con botones de su color, con la del puesto de quien cobra ya
// marcada. Se piden una vez por sesión (/v1/venues/me); si no llegan, las de
// fábrica (el servidor decide igual por el puesto).

import { useEffect, useState } from 'react';
import {
  DEFAULT_SECTIONS,
  SECTION_CODES,
  sectionMeta,
  type PostCode,
  type SectionCode,
  type VenueSection,
} from '@nightpay/contracts';
import { fetchMySections, getUser, type MySections } from './api';

export const FALLBACK_SECTIONS: VenueSection[] = SECTION_CODES.map((code) => ({ code, ...DEFAULT_SECTIONS[code] }));

/**
 * Las que se ofrecen: encendidas y que su puesto puede cobrar (el servidor
 * rechaza el resto). Sin ninguna (datos raros), las de fábrica: el servidor decide.
 */
export function offeredSections(all: readonly VenueSection[], allowed: readonly SectionCode[] | null = null): VenueSection[] {
  const on = all.filter((s) => s.enabled && (!allowed || allowed.includes(s.code)));
  return on.length > 0 ? on : FALLBACK_SECTIONS.filter((s) => !allowed || allowed.includes(s.code));
}

/** La sección marcada al empezar: la del puesto si se ofrece; si no, la primera. */
export function initialSection(offered: readonly VenueSection[], preferred: SectionCode | null): SectionCode {
  if (preferred && offered.some((s) => s.code === preferred)) return preferred;
  return offered[0]?.code ?? 'VENUE_BAR';
}

/** El chip de Recepción: la sección de las entradas, con el nombre que le dio el local (Ajustes → Secciones). */
export function receptionChip(sections: readonly VenueSection[]): { section: SectionCode; label: string } {
  return { section: 'VENUE_ENTRY', label: sectionMeta(sections, 'VENUE_ENTRY').label };
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
  allowed: SectionCode[] | null;
  /** Su puesto (null: sin puesto o el API anterior). */
  post?: PostCode | null;
  /** Su puesto lleva propinas (null: no se sabe; el API decide). */
  tips?: boolean | null;
  /** Ya contestó el API (con lo suyo o sin respuesta). */
  loaded?: boolean;
}

export function useMySections(): MySectionsState {
  const [state, setState] = useState<MySectionsState>({ sections: FALLBACK_SECTIONS, defaultCategory: null, allowed: null });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((s) => {
        if (!cancelled) {
          setState({
            sections: s.sections.length > 0 ? s.sections : FALLBACK_SECTIONS,
            defaultCategory: s.defaultCategory,
            allowed: s.allowed,
            post: s.post ?? null,
            tips: s.tips ?? null,
            loaded: true,
          });
        }
      })
      .catch(() => {
        // Sin respuesta: las de fábrica; el servidor pone la del puesto si hace falta.
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
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
