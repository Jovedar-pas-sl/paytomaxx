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
