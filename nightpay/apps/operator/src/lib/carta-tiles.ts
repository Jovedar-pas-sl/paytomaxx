// «Cobrar» (maqueta 1.1): las losetas de la carta y qué hace tocar cada una.
// Funciones puras (se prueban sin pantalla). La «Copa» es la copa normal:
// tocarla la suma a la cuenta. La «Copa con invitación» (isInvitation) es una
// loseta más, en su sitio de la carta (en la de referencia, justo después de
// «Copa»): tocarla abre el escáner del QR de la chica y se cobra aparte.

import type { CartaItem } from './cuenta';

/** ¿Puede cobrar esta cosa de la carta? (un pack, todas sus partes). */
export function itemAllowed(item: Pick<CartaItem, 'category' | 'components'>, codes: readonly string[]): boolean {
  const parts = item.components && item.components.length > 0 ? item.components.map((p) => p.category) : [item.category];
  return parts.every((p) => codes.includes(p));
}

function sectionOrder(codes: readonly string[], code: string): number {
  const i = codes.indexOf(code);
  return i < 0 ? codes.length : i;
}

/**
 * Las losetas: lo que su puesto cobra, en el orden de las secciones y, dentro
 * de cada una, en el de la carta (como llega del API: sortOrder y precio).
 */
export function cartaTiles<T extends CartaItem>(carta: readonly T[], codes: readonly string[]): T[] {
  return carta
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => itemAllowed(item, codes))
    .sort((a, b) => sectionOrder(codes, a.item.category) - sectionOrder(codes, b.item.category) || a.index - b.index)
    .map(({ item }) => item);
}

/** Tocar una loseta: sumarla a la cuenta o, una copa con invitación, escanear el QR de la chica. */
export function tapOf(item: Pick<CartaItem, 'isInvitation'>): 'sumar' | 'invitar' {
  return item.isInvitation === true ? 'invitar' : 'sumar';
}
