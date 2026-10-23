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
  label: string;
  before: Cuenta;
}

export function addedItemLabel(name: string): string {
  return `+1 ${name}`;
}

export function addedTipLabel(cents: number): string {
  return `+${formatEur(cents, { compact: true })} de propina`;
}

/** «Deshacer»: la cuenta como estaba antes del último toque (la misma, sin copiarla: es inmutable). */
export function undoTap(undo: UndoTap | null, current: Cuenta): Cuenta {
  return undo ? undo.before : current;
}
