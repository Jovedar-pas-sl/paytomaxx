// «Cobrar» (maqueta 1.1–1.4): la cuenta que va montando quien cobra. Cosas de
// la carta (×N), importes tecleados en una sección («Otro importe») y la
// propina que pide el cliente. Cada línea va a su sección y el cliente paga
// una sola vez. Funciones puras: la pantalla guarda la cuenta y la cambia con
// ellas (siempre una cuenta nueva, nunca la misma modificada).

import type { TicketLine } from '@nightpay/ui';
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
  /** Icono de la colección (null = el de su sección). */
  icon?: string | null;
  /** Ruta de su logo o foto (versionada por su huella), o null. */
  imageUrl?: string | null;
  /** «Agotado esta noche»: no se añade a la cuenta. */
  soldOut?: boolean;
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

/**
 * «Otro importe» tecleado: con la cuenta vacía (y si no es una propina) se
 * cobra ya; si no, se suma a la cuenta y se vuelve a la carta. `next` es la
 * cuenta con el importe, pero al cobrar no se apunta hasta que el cobro se abre.
 */
export type OtroPlan = { kind: 'cobrar' | 'sumar'; next: Cuenta };

export function otroPlan(cuenta: Cuenta, section: CuentaSection, amountCents: number): OtroPlan {
  const next = addAmount(cuenta, section, amountCents);
  return { kind: cuenta.length === 0 && section !== PROPINAS ? 'cobrar' : 'sumar', next };
}

/**
 * Cobra `next` y solo si el cobro se abrió la deja como la cuenta: un fallo
 * (sin red, 5xx) deja la cuenta como estaba y el reintento cobra lo mismo, no
 * el doble (APP-01).
 */
export async function cobrarYApuntar(
  next: Cuenta,
  open: (cuenta: Cuenta) => Promise<boolean>,
  apuntar: (cuenta: Cuenta) => void,
): Promise<boolean> {
  const opened = await open(next);
  if (opened) apuntar(next);
  return opened;
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

/** La cuenta, línea a línea, para el ticket impreso: «2× Gin tonic … 24,00 €». */
export function ticketLinesOf(cuenta: Cuenta): TicketLine[] {
  return cuenta.map((l): TicketLine => {
    if (l.kind === 'carta') return { label: itemLabel(l.item), qty: l.qty, unitCents: l.item.priceCents, amountCents: l.item.priceCents * l.qty };
    if (l.kind === 'importe') return { label: 'Otro importe', qty: 1, amountCents: l.amountCents };
    return { label: 'Propina', qty: 1, amountCents: l.amountCents };
  });
}

/** Nombre de una cosa de la carta y, si no lo dice ya, su duración. */
export function itemLabel(item: Pick<CartaItem, 'name' | 'durationMin'>): string {
  if (!item.durationMin || /\d+\s*(?:min|h(?:oras?)?)(?:\b|$)/i.test(item.name) || item.name.includes(String(item.durationMin))) return item.name;
  const duration = item.durationMin % 60 === 0 ? `${item.durationMin / 60} h` : `${item.durationMin} min`;
  return `${item.name} · ${duration}`;
}

/**
 * «2× Gin tonic», «Nachos»: el nombre tal como lo escribió el local. Nunca se
 * inventa un plural ni se recorta (como el API: «2× Copa · Habitación»).
 */
function qtyName(qty: number, name: string): string {
  return qty > 1 ? `${qty}× ${name}` : name;
}

/**
 * La cuenta en una línea, abajo: «1 h · Servicios» (una sola cosa), «2× Gin
 * tonic + Nachos», «2× Copa + Tabla ibérica + 2 más».
 */
export function cuentaSummary(cuenta: Cuenta, sectionLabel: (section: string) => string): string {
  if (cuenta.length === 0) return '';
  const label = (l: CuentaLine): string => {
    if (l.kind === 'propina') return 'propina';
    if (l.kind === 'importe') return 'otro importe';
    return qtyName(l.qty, l.item.name);
  };
  if (cuenta.length === 1) {
    const only = cuenta[0]!;
    if (only.kind === 'carta') return `${qtyName(only.qty, itemLabel(only.item))} · ${sectionLabel(only.item.category)}`;
    return only.kind === 'propina' ? 'Propina' : `Otro importe · ${sectionLabel(only.category)}`;
  }
  const parts = cuenta.map(label);
  if (parts.length <= 3) return parts.join(' + ');
  return `${parts.slice(0, 2).join(' + ')} + ${parts.length - 2} más`;
}

/**
 * Lo que se cobra, corto (la banda de «Esperando» y el PAGADO): «2× Copa»,
 * «1 h», «2× Gin tonic + Nachos», «Copa + Tabla ibérica + 2 más».
 */
export function cuentaWhat(cuenta: Cuenta): string {
  const label = (l: CuentaLine, alone: boolean): string => {
    if (l.kind === 'propina') return 'propina';
    if (l.kind === 'importe') return 'otro importe';
    return qtyName(l.qty, alone ? itemLabel(l.item) : l.item.name);
  };
  const sold = cuenta.filter((l) => l.kind !== 'propina');
  const parts = (sold.length > 0 ? sold : cuenta).map((l, _, all) => label(l, all.length === 1));
  if (parts.length <= 2) return parts.join(' + ');
  return `${parts.slice(0, 2).join(' + ')} + ${parts.length - 2} más`;
}
