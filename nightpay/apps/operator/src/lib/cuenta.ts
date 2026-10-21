// «Cobrar» (maqueta 1.1–1.4): la cuenta que va montando quien cobra. Cosas de
// la carta (×N), importes tecleados en una sección («Otro importe») y la
// propina que pide el cliente. Cada línea va a su sección y el cliente paga
// una sola vez. Funciones puras: la pantalla guarda la cuenta y la cambia con
// ellas (siempre una cuenta nueva, nunca la misma modificada).

import type { ChargeLineInput, SectionCode } from '@nightpay/contracts';

/** Lo que hace falta de un servicio de la carta. */
export interface CartaItem {
  id: string;
  name: string;
  priceCents: number;
  category: string;
  durationMin?: number | null;
  /** Pack: sus partes (cada una a su sección). */
  components?: ReadonlyArray<{ category: string; amountCents: number }> | null;
  isInvitation?: boolean;
}

/** Propinas: no son una sección de línea, van aparte (tipCents); en la pantalla, con su color. */
export const PROPINAS = 'propinas' as const;
export type CuentaSection = SectionCode | typeof PROPINAS;

export type CuentaLine =
  | { kind: 'carta'; key: string; item: CartaItem; qty: number }
  | { kind: 'importe'; key: string; category: SectionCode; amountCents: number }
  | { kind: 'propina'; key: string; amountCents: number };

export type Cuenta = readonly CuentaLine[];

export const EMPTY_CUENTA: Cuenta = [];

/** Lo más de cada cosa (como el API). */
export const MAX_QTY = 50;

let seq = 0;
const nextKey = (prefix: string): string => `${prefix}-${(seq += 1)}`;

/** Una más de esta cosa de la carta (o la primera). */
export function addItem(cuenta: Cuenta, item: CartaItem): Cuenta {
  const found = cuenta.find((l) => l.kind === 'carta' && l.item.id === item.id);
  if (found && found.kind === 'carta') return setQty(cuenta, found.key, found.qty + 1);
  return [...cuenta, { kind: 'carta', key: nextKey('c'), item, qty: 1 }];
}

/** Cuántas de una línea de la carta; 0 la quita. */
export function setQty(cuenta: Cuenta, key: string, qty: number): Cuenta {
  if (qty <= 0) return removeLine(cuenta, key);
  return cuenta.map((l) => (l.key === key && l.kind === 'carta' ? { ...l, qty: Math.min(qty, MAX_QTY) } : l));
}

/** «Otro importe» en una sección, o una propina. */
export function addAmount(cuenta: Cuenta, section: CuentaSection, amountCents: number): Cuenta {
  if (amountCents <= 0) return cuenta;
  if (section === PROPINAS) return [...cuenta, { kind: 'propina', key: nextKey('p'), amountCents }];
  return [...cuenta, { kind: 'importe', key: nextKey('i'), category: section, amountCents }];
}

export function removeLine(cuenta: Cuenta, key: string): Cuenta {
  return cuenta.filter((l) => l.key !== key);
}

/** Cuántas lleva de esa cosa de la carta (el ×N de su loseta). */
export function qtyOf(cuenta: Cuenta, itemId: string): number {
  const found = cuenta.find((l) => l.kind === 'carta' && l.item.id === itemId);
  return found && found.kind === 'carta' ? found.qty : 0;
}

/** Importe de una línea. */
export function lineCents(line: CuentaLine): number {
  return line.kind === 'carta' ? line.item.priceCents * line.qty : line.amountCents;
}

/** Sección de una línea (un pack, la de su parte más grande). */
export function lineSection(line: CuentaLine): CuentaSection | string {
  if (line.kind === 'propina') return PROPINAS;
  if (line.kind === 'importe') return line.category;
  return line.item.category;
}

export interface CuentaTotals {
  /** Lo que se vende (sin propina). */
  amountCents: number;
  tipCents: number;
  /** Lo que paga el cliente. */
  totalCents: number;
  /** Cada sección con su importe, en el orden en que entraron (la franja y «Cómo se reparte»). */
  bySection: Array<{ section: string; cents: number }>;
}

export function cuentaTotals(cuenta: Cuenta): CuentaTotals {
  const by = new Map<string, number>();
  let amountCents = 0;
  let tipCents = 0;
  for (const line of cuenta) {
    const cents = lineCents(line);
    if (line.kind === 'propina') tipCents += cents;
    else amountCents += cents;
    // Un pack reparte en sus partes.
    const parts =
      line.kind === 'carta' && line.item.components && line.item.components.length > 0
        ? line.item.components.map((p) => ({ section: p.category, cents: p.amountCents * line.qty }))
        : [{ section: lineSection(line), cents }];
    for (const p of parts) by.set(p.section, (by.get(p.section) ?? 0) + p.cents);
  }
  return {
    amountCents,
    tipCents,
    totalCents: amountCents + tipCents,
    bySection: [...by.entries()].map(([section, cents]) => ({ section, cents })),
  };
}

/** ¿Se puede cobrar? Algo que vender (una propina sola no es un cobro). */
export function chargeable(cuenta: Cuenta): boolean {
  return cuenta.some((l) => l.kind !== 'propina');
}

/** Las líneas para el API (la propina va aparte, en tipCents). */
export function chargeLinesOf(cuenta: Cuenta): ChargeLineInput[] {
  return cuenta.flatMap((l): ChargeLineInput[] => {
    if (l.kind === 'carta') return [{ serviceItemId: l.item.id, qty: l.qty }];
    if (l.kind === 'importe') return [{ category: l.category, amountCents: l.amountCents, label: 'Otro importe' }];
    return [];
  });
}

/** Nombre de una cosa de la carta y, si no lo dice ya, su duración. */
export function itemLabel(item: Pick<CartaItem, 'name' | 'durationMin'>): string {
  if (!item.durationMin || /\d+\s*(?:min|h(?:oras?)?)(?:\b|$)/i.test(item.name) || item.name.includes(String(item.durationMin))) return item.name;
  const duration = item.durationMin % 60 === 0 ? `${item.durationMin / 60} h` : `${item.durationMin} min`;
  return `${item.name} · ${duration}`;
}

/** «copa» → «copas», «tabla» → «tablas», «ración» → «raciones». */
export function plural(word: string): string {
  if (/[aeiouáéó]$/i.test(word)) return `${word}s`;
  if (/ón$/i.test(word)) return `${word.slice(0, -2)}ones`;
  if (/z$/i.test(word)) return `${word.slice(0, -1)}ces`;
  return `${word}es`;
}

function shortName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? name).toLowerCase();
}

/**
 * La cuenta en una línea, abajo: «1 h · Servicios» (una sola cosa), «2 copas
 * + tabla», «2 copas + tabla + 2 más».
 */
export function cuentaSummary(cuenta: Cuenta, sectionLabel: (section: string) => string): string {
  if (cuenta.length === 0) return '';
  const label = (l: CuentaLine): string => {
    if (l.kind === 'propina') return 'propina';
    if (l.kind === 'importe') return 'otro importe';
    return l.qty > 1 ? `${l.qty} ${plural(shortName(l.item.name))}` : shortName(l.item.name);
  };
  if (cuenta.length === 1) {
    const only = cuenta[0]!;
    if (only.kind === 'carta') return `${only.qty > 1 ? `${only.qty}× ` : ''}${itemLabel(only.item)} · ${sectionLabel(only.item.category)}`;
    return only.kind === 'propina' ? 'Propina' : `Otro importe · ${sectionLabel(only.category)}`;
  }
  const parts = cuenta.map(label);
  if (parts.length <= 3) return parts.join(' + ');
  return `${parts.slice(0, 2).join(' + ')} + ${parts.length - 2} más`;
}

/**
 * Lo que se cobra, corto (la banda de «Esperando» y el PAGADO): «2 copas»,
 * «1 h», «2 copas + tabla», «copa + tabla + 2 más».
 */
export function cuentaWhat(cuenta: Cuenta): string {
  const label = (l: CuentaLine, alone: boolean): string => {
    if (l.kind === 'propina') return 'propina';
    if (l.kind === 'importe') return 'otro importe';
    if (l.qty > 1) return `${l.qty} ${plural(shortName(l.item.name))}`;
    return alone ? itemLabel(l.item) : shortName(l.item.name);
  };
  const sold = cuenta.filter((l) => l.kind !== 'propina');
  const parts = (sold.length > 0 ? sold : cuenta).map((l, _, all) => label(l, all.length === 1));
  if (parts.length <= 2) return parts.join(' + ');
  return `${parts.slice(0, 2).join(' + ')} + ${parts.length - 2} más`;
}
