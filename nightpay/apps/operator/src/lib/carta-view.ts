// «Cobrar» (la carta): lo que dicen el botón de abajo, cada loseta y el
// «Deshacer» del pie. Funciones puras: la pantalla las pinta.

import { formatEur } from './money';
import type { Cuenta } from './cuenta';

/** Lo que dura «Deshacer» en el pie tras cada toque (decisión D3). */
export const UNDO_MS = 4_000;

/**
 * El botón grande de abajo. Sin nada en la cuenta no dice «Cobrar»: dice
 * qué hacer (y va en gris, no en lima: el lima es «listo para cobrar»).
 */
export function cobrarLabel({ busy, empty, totalCents }: { busy: boolean; empty: boolean; totalCents: number }): string {
  if (busy) return 'Un momento…';
  if (empty) return 'Toca lo que te pide el cliente';
  return `Cobrar ${formatEur(totalCents, { compact: true })}`;
}

/**
 * Nombre de la loseta para el lector de pantalla, con lo que lleva la cuenta:
 * «Gin tonic, 12,00 €, 2 en la cuenta».
 */
export function tileLabel(name: string, priceCents: number, { qty = 0, invite = false }: { qty?: number; invite?: boolean } = {}): string {
  const base = `${name}, ${formatEur(priceCents)}`;
  if (invite) return `${base}. Escanea el QR de la chica`;
  return qty > 0 ? `${base}, ${qty} en la cuenta` : base;
}

/** Lo último que se tocó: «+1 Nachos» o «+2 € de propina» (y cómo estaba la cuenta antes). */
export interface UndoTap {
  id: number;
  /** Lo que se ve en el pie: «+1 Nachos». */
  label: string;
  /** Lo que oye el lector de pantalla: cambia en cada toque («+1 Nachos, 2 en la cuenta»). */
  spoken: string;
  /** La loseta que se tocó (data-tile): ahí vuelve el foco si «Deshacer» se va con él. */
  tile: string;
  before: Cuenta;
}

export function addedItemLabel(name: string): string {
  return `+1 ${name}`;
}

export function addedTipLabel(cents: number): string {
  return `+${formatEur(cents, { compact: true })} de propina`;
}

/** «+1 Nachos, 2 en la cuenta»: el mismo toque dos veces suena distinto (si no, no se repite). */
export function addedItemSpoken(name: string, qtyInCuenta: number): string {
  return `${addedItemLabel(name)}, ${qtyInCuenta} en la cuenta`;
}

/** «+2 € de propina, 4 € de propina en la cuenta». */
export function addedTipSpoken(cents: number, tipTotalCents: number): string {
  return `${addedTipLabel(cents)}, ${formatEur(tipTotalCents, { compact: true })} de propina en la cuenta`;
}

/** El data-tile de la loseta de un producto. */
export function itemTileKey(itemId: string): string {
  return itemId;
}

/** El data-tile de una loseta de propina. */
export function tipTileKey(cents: number): string {
  return `tip-${cents}`;
}

/**
 * Dónde va el foco si «Deshacer» desaparece teniéndolo (caduca a los 4 s o se
 * toca): a la loseta que se tocó; si no está, al resumen de la cuenta.
 */
export function undoFocusTarget<T>(root: { querySelector(selector: string): T | null }, tile: string): T | null {
  return root.querySelector(`[data-tile=${JSON.stringify(tile)}]`) ?? root.querySelector('[data-sum]');
}

/** «Deshacer»: la cuenta como estaba antes del último toque (la misma, sin copiarla: es inmutable). */
export function undoTap(undo: UndoTap | null, current: Cuenta): Cuenta {
  return undo ? undo.before : current;
}
