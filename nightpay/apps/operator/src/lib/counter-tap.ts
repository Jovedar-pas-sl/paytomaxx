// El lector siempre escuchando en el mostrador (estudio de fichas, A3): con
// la ficha del cliente que se atiende no pasa nada; con otra, solo un aviso
// («Esa es la 1014, no la 1013»). Nunca cambia de pantalla, ni cierra
// CARGADO, ni carga nada. Funciones puras (counter-tap.test.ts).

import { normalizePrintedFichaNumber, type ReceptionDeskView } from '@nightpay/contracts';
import { wrongFichaText } from './ficha-number';

/** La ficha del cliente que se atiende: su código grabado (si se acercó) y su número impreso. */
export interface CounterFicha {
  card: string | null;
  printed: string | null;
}

/** Lo leído en el mostrador: la ficha acercada, el saldo por su código o la ficha por su número. */
export interface CounterRead {
  view: ReceptionDeskView | null;
  nfc: { card: string } | null;
  number?: { printedNumber: string };
}

/** La ficha que hay en el mostrador ahora (sin ficha: card y printed a null, y cualquiera es «otra»). */
export function counterFicha(read: CounterRead): CounterFicha {
  if (read.number) return { card: null, printed: read.number.printedNumber };
  const view = read.view;
  const hasFicha = view !== null && !(view.kind === 'saldo' && view.fichaNumber === null);
  return { card: read.nfc?.card ?? null, printed: hasFicha ? (view.printedNumber ?? null) : null };
}

/** ¿Es la misma ficha, sin preguntar al servidor? (mismo código grabado). */
export function sameCounterCard(here: CounterFicha, token: string | null): boolean {
  return token !== null && here.card !== null && here.card === token;
}

/**
 * Lo que se dice al acercar una ficha en el mostrador: null si es la del
 * cliente (no pasa nada); si no, el aviso. `tapped.printed`: el número
 * impreso de la acercada (null: en blanco, de otro local, sin número…). Por
 * su número (sin código grabado que comparar), vale el mismo número impreso.
 */
export function counterTapText(here: CounterFicha, tapped: { token: string | null; printed: string | null }): string | null {
  if (sameCounterCard(here, tapped.token)) return null;
  if (here.card === null && here.printed && tapped.printed) {
    if (normalizePrintedFichaNumber(here.printed) === normalizePrintedFichaNumber(tapped.printed)) return null;
  }
  return wrongFichaText(here.printed, tapped.printed);
}

/**
 * B2: el efectivo se confirma acercando otra vez la misma ficha. Solo si hay
 * ficha que acercar (leída, buscada por su número o de un saldo con ficha);
 * sin ficha (saldo nuevo sin ficha, saldo sin ficha), como siempre.
 */
export function needsFichaCheck(ficha: CounterFicha): boolean {
  return ficha.card !== null || ficha.printed !== null;
}

/**
 * B2 (y B4): «acercar otra vez la misma ficha» es retirarla y volver a
 * acercarla. Web NFC no avisa de cuándo se retira una ficha: la que sigue
 * apoyada se lee en cuanto el lector vuelve a escuchar. Por eso solo cuenta
 * la lectura que llega tras un hueco sin ficha (FRESH_TAP_MS esperando); la
 * misma presencia, leída una y otra vez, nunca confirma nada.
 */
export const FRESH_TAP_MS = 1_500;

/** «¿Es una ficha acercada de nuevo?» (`waitedMs`: lo que esperó el lector a esta lectura). */
export function isFreshTap(waitedMs: number): boolean {
  return waitedMs >= FRESH_TAP_MS;
}

/**
 * B2: la misma ficha confirma el efectivo solo si se ha retirado y vuelto a
 * acercar (isFreshTap) y ya ha pasado el medio segundo de la pantalla (el
 * doble toque en «Efectivo», S-1a). Apoyada sin moverla, no carga nada.
 */
export function confirmsWithFicha(o: { waitedMs: number; shownAt: number; now: number; armMs: number }): boolean {
  return isFreshTap(o.waitedMs) && o.now - o.shownAt >= o.armMs;
}

/** B3: en CARGADO, otra ficha cierra y abre la siguiente; salvo con el PIN pendiente o el QR de Face ID abierto. */
export type LoadedOtherTap = 'next' | 'pin' | 'qr';

export function loadedOtherTap(o: { pinPending: boolean; faceQrOpen: boolean }): LoadedOtherTap {
  if (o.pinPending) return 'pin';
  if (o.faceQrOpen) return 'qr';
  return 'next';
}

/** Lo que se dice si CARGADO no se cierra con la otra ficha (B3): el aviso de A3 y qué falta. */
export function loadedBlockedText(base: string, why: Exclude<LoadedOtherTap, 'next'>): string {
  return why === 'pin'
    ? `${base}. Antes, que este cliente elija su PIN o toque «Ahora no»`
    : `${base}. Su QR de Face ID sigue abierto: cuando termine, «Siguiente cliente»`;
}
