'use client';

// OxioParty: cómo se llama el sitio donde cobra quien ha entrado. La caseta
// del personal (`stall`, StallRef de @nightpay/contracts) llega en
// GET /v1/venues/me; sin caseta, el nombre del local.

import { createContext, useContext } from 'react';
import type { StallRef } from '@nightpay/contracts';

export interface VenueIdentity {
  /** El nombre del local (la fiesta o el organizador). */
  venueName: string | null;
  /** La caseta de quien cobra (null: sin caseta). */
  stallName: string | null;
}

export const NO_IDENTITY: VenueIdentity = { venueName: null, stallName: null };

/** Lo que usa de GET /v1/venues/me: el nombre del local y la caseta de quien entra. */
export interface VenueIdentitySource {
  name?: string | null;
  stall?: StallRef | null;
}

function text(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** La respuesta de /v1/venues/me → el local y la caseta (lo que falte, null). */
export function venueIdentityOf(me: VenueIdentitySource | null | undefined): VenueIdentity {
  if (!me) return NO_IDENTITY;
  return { venueName: text(me.name), stallName: text(me.stall?.name) };
}

/** El nombre de la cabecera: la caseta; sin ella, el local; sin nada, `fallback`. */
export function placeName(identity: VenueIdentity, fallback: string): string {
  return identity.stallName ?? identity.venueName ?? fallback;
}

/** Las iniciales del sitio para su cuadro (la primera y la última palabra): «Peña El Cántaro» → «PC». */
export function placeInitials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = (words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1)).map((w) => {
    const first = [...w].find((ch) => /[\p{L}\p{N}]/u.test(ch));
    return first ?? '';
  });
  const joined = letters.join('').toLocaleUpperCase('es-ES');
  return joined || '·';
}

export const VenueIdentityContext = createContext<VenueIdentity>(NO_IDENTITY);

export function useVenueIdentity(): VenueIdentity {
  return useContext(VenueIdentityContext);
}
