'use client';

// OxioParty: cómo se llama el sitio donde cobra quien ha entrado. La caseta
// del personal (stall) la añade el API a GET /v1/venues/me; mientras no
// llegue (o en un API anterior), el nombre del local. Se lee con cuidado: el
// campo aún no está en los tipos.

import { createContext, useContext } from 'react';

export interface VenueIdentity {
  /** El nombre del local (la fiesta o el organizador). */
  venueName: string | null;
  /** La caseta de quien cobra (null: sin caseta o un API que aún no la dice). */
  stallName: string | null;
}

export const NO_IDENTITY: VenueIdentity = { venueName: null, stallName: null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** La respuesta de /v1/venues/me → el local y la caseta (lo que falte, null). */
export function venueIdentityOf(me: unknown): VenueIdentity {
  if (!me || typeof me !== 'object') return NO_IDENTITY;
  const stall = (me as { stall?: { name?: unknown } | null }).stall;
  return {
    venueName: text((me as { name?: unknown }).name),
    stallName: stall && typeof stall === 'object' ? text(stall.name) : null,
  };
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
