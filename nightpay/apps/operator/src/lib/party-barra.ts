// OxioParty · la barra de una caseta (maqueta Main.dc.html): la carta en
// losetas con un filtro por sección, el ticket de abajo con − y + y el PAGADO
// con su detalle. Funciones puras sobre la cuenta de siempre (lib/cuenta): el
// cobro con varias líneas es el mismo (POST /v1/payments con `lines`).

import type { SectionCode, VenueSection } from '@nightpay/contracts';
import { cartaTiles } from './carta-tiles';
import { lineCents, removeLine, setQty, type CartaItem, type Cuenta } from './cuenta';
import { formatEur } from './money';

/** En una fiesta no hay habitaciones ni servicios de chicas: esas secciones no salen. */
export const PARTY_HIDDEN_SECTIONS: readonly SectionCode[] = ['CHICA_SERVICE', 'VENUE_ROOM'];

/** Las secciones del local sin las que no son de una fiesta (apagadas: ni losetas ni «Otro importe»). */
export function partySections(sections: readonly VenueSection[]): VenueSection[] {
  return sections.map((s) => (PARTY_HIDDEN_SECTIONS.includes(s.code) ? { ...s, enabled: false } : s));
}

/** Las losetas de la barra: lo que su puesto cobra, sin las copas con invitación (no hay chicas). */
export function barraTiles<T extends CartaItem>(carta: readonly T[], codes: readonly string[]): T[] {
  return cartaTiles(carta, codes).filter((item) => item.isInvitation !== true);
}

/** El filtro de arriba: «Todo» o una sección. */
export const ALL = 'all';

export interface BarraFilter {
  key: string;
  label: string;
}

/**
 * «Todo» más cada sección que tiene losetas, en su orden. Con una sola
 * sección no hay nada que filtrar: ningún filtro.
 */
export function barraFilters(tiles: readonly Pick<CartaItem, 'category'>[], labelOf: (section: string) => string): BarraFilter[] {
  const sections = [...new Set(tiles.map((t) => t.category))];
  if (sections.length < 2) return [];
  return [{ key: ALL, label: 'Todo' }, ...sections.map((s) => ({ key: s, label: labelOf(s) }))];
}

/** El filtro que vale: el elegido si sigue existiendo (la carta puede cambiar); si no, «Todo». */
export function resolveFilter(filter: string, filters: readonly BarraFilter[]): string {
  return filters.some((f) => f.key === filter) ? filter : ALL;
}

/** Las losetas que se ven con el filtro puesto. */
export function filterTiles<T extends Pick<CartaItem, 'category'>>(tiles: readonly T[], filter: string): T[] {
  return filter === ALL ? [...tiles] : tiles.filter((t) => t.category === filter);
}

/** El icono de la loseta, por su sección: bebida, comida, entrada u otra cosa. */
export type TileIcon = 'drink' | 'food' | 'ticket' | 'other';

export function tileIconOf(section: string): TileIcon {
  if (section === 'VENUE_BAR') return 'drink';
  if (section === 'VENUE_FOOD') return 'food';
  if (section === 'VENUE_ENTRY') return 'ticket';
  return 'other';
}

/** Una línea del ticket: lo de la carta con − y +; un «Otro importe», solo con − (lo quita). */
export interface TicketLine {
  key: string;
  name: string;
  qty: number;
  cents: number;
  /** Se puede sumar uno más (lo de la carta). */
  canAdd: boolean;
}

export function ticketLines(cuenta: Cuenta): TicketLine[] {
  return cuenta.map((l) => {
    if (l.kind === 'carta') return { key: l.key, name: l.item.name, qty: l.qty, cents: lineCents(l), canAdd: true };
    return { key: l.key, name: l.kind === 'importe' ? 'Otro importe' : 'Propina', qty: 1, cents: lineCents(l), canAdd: false };
  });
}

/** Cuántas cosas lleva el ticket (cada unidad de la carta y cada importe). */
export function ticketCount(cuenta: Cuenta): number {
  return cuenta.reduce((n, l) => n + (l.kind === 'carta' ? l.qty : 1), 0);
}

/** «Ticket · 1 artículo» / «Ticket · 3 artículos». */
export function ticketTitle(count: number): string {
  return `Ticket · ${count} ${count === 1 ? 'artículo' : 'artículos'}`;
}

/** − o + en una línea del ticket (a 0, fuera). Siempre una cuenta nueva. */
export function stepLine(cuenta: Cuenta, key: string, delta: 1 | -1): Cuenta {
  const line = cuenta.find((l) => l.key === key);
  if (!line) return cuenta;
  if (line.kind !== 'carta') return delta < 0 ? removeLine(cuenta, key) : cuenta;
  return setQty(cuenta, key, line.qty + delta);
}

/** El botón de abajo: «Cobrar 7,00 €». */
export function barraCobrarLabel(totalCents: number): string {
  return `Cobrar ${formatEur(totalCents)}`;
}

/** Lo que el lector de pantalla dice de una loseta: «Añadir Caña, 2,00 €» (y cuántas lleva). */
export function barraTileAria(name: string, priceCents: number, qty: number): string {
  const base = `Añadir ${name}, ${formatEur(priceCents)}`;
  return qty > 0 ? `${base}. Lleva ${qty}` : base;
}

/** «2 × caña · 1 × tinto de verano»: lo que se cobra, debajo del importe al cobrar. */
export function ticketSummary(cuenta: Cuenta): string {
  return ticketLines(cuenta)
    .map((l) => `${l.qty} × ${l.name.toLocaleLowerCase('es-ES')}`)
    .join(' · ');
}

// ─── PAGADO ─────────────────────────────────────────────────────────────

/** El PAGADO de la barra vuelve solo a la carta pasado este tiempo (la maqueta: 3 s). */
export const PARTY_PAID_BACK_MS = 3_000;

export interface PaidRow {
  label: string;
  value: string;
}

/** La hora del pago («01:47», en la hora de España como el resto de la app). */
export function paidClock(at: Date): string {
  return at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
}

/**
 * El detalle del PAGADO (maqueta: Pulsera, Le quedan, Hora): solo lo que el
 * API dice. La pulsera, si se pagó con ella y el API da su número; lo que le
 * queda, si lo devuelve; con tarjeta, cómo se pagó y el código del cobro (el
 * mismo que ve el cliente en su móvil).
 */
export function partyPaidRows(o: {
  method: 'card' | 'saldo';
  pulsera: string | null;
  newBalanceCents: number | null;
  /** Con tarjeta: Apple Pay o Google Pay. */
  wallet?: boolean;
  code?: string | null;
  at: Date;
}): PaidRow[] {
  const rows: PaidRow[] = [];
  if (o.method === 'saldo') {
    if (o.pulsera) rows.push({ label: 'Pulsera', value: o.pulsera });
    if (o.newBalanceCents !== null) rows.push({ label: 'Le quedan', value: formatEur(o.newBalanceCents) });
  } else {
    rows.push({ label: 'Pagado con', value: o.wallet ? 'Apple Pay o Google Pay' : 'Tarjeta' });
    if (o.code) rows.push({ label: 'Código del cobro', value: o.code });
  }
  rows.push({ label: 'Hora', value: paidClock(o.at) });
  return rows;
}
