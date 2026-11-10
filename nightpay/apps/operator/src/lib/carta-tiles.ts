// «Cobrar» (maqueta 1.1): las losetas de la carta y qué hace tocar cada una.
// Funciones puras (se prueban sin pantalla). La «Copa» es la copa normal:
// tocarla la suma a la cuenta. La «Copa con invitación» (isInvitation) es una
// loseta más, en su sitio de la carta (en la de referencia, justo después de
// «Copa»): tocarla abre el escáner del QR de la chica y se cobra aparte.

import { sectionTileVar } from '@nightpay/ui';
import type { CartaItem } from './cuenta';

/**
 * El relleno de una loseta: el color sólido de su sección, con tinta encima
 * (--np-on-section, ≥ 4,5:1 en todas). Servicios y Propinas, en su tono de
 * loseta (un punto más claro). Las propinas van por su clave («propinas»).
 * El punto del título de cada grupo sigue con el color exacto (colorOf).
 */
export function cartaTileColor(section: string): string {
  return sectionTileVar(section);
}

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

/** Un grupo de la carta: su sección y sus losetas. */
export interface CartaGroup<T> {
  section: string;
  items: T[];
}

/**
 * Las losetas por grupos de la misma sección, seguidos (cartaTiles ya las
 * deja juntas): la pantalla pone el título de cada sección una sola vez.
 */
export function cartaGroups<T extends Pick<CartaItem, 'category'>>(tiles: readonly T[]): CartaGroup<T>[] {
  return tiles.reduce<CartaGroup<T>[]>((groups, item) => {
    const last = groups[groups.length - 1];
    return last && last.section === item.category
      ? [...groups.slice(0, -1), { section: last.section, items: [...last.items, item] }]
      : [...groups, { section: item.category, items: [item] }];
  }, []);
}
