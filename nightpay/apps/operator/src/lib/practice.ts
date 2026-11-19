// «Modo práctica»: el personal ensaya las pantallas de verdad sin mover dinero
// ni crear nada en el servidor. El estado vive solo en este móvil (memoria y
// sessionStorage de la pestaña): nunca viaja a otro aparato ni al API.

import { useSyncExternalStore } from 'react';

const KEY = 'np_practice';

/** Todo lo simulado lleva este prefijo en su id: se reconoce a la vista y nunca coincide con uno real. */
export const PRACTICE_ID_PREFIX = 'PRACT-';

/** La frase que lleva el QR de práctica (texto plano, no un enlace: ninguna cámara abre nada). */
export const PRACTICE_QR_TEXT = 'PRÁCTICA — no es un pago';

export const PRACTICE_BAND_TEXT = 'PRÁCTICA · nada de esto es de verdad';

/** Lo que se lanza si en práctica algo intenta cambiar datos en el servidor. */
export class PracticeBlockedError extends Error {
  constructor(what: string) {
    super(`Estás en modo práctica: «${what}» no se hace de verdad. Sal de la práctica para usarlo.`);
    this.name = 'PracticeBlockedError';
  }
}

function stored(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let on = stored();
const listeners = new Set<() => void>();

export function isPractice(): boolean {
  return on;
}

/** Enciende o apaga la práctica (y avisa a quien la mira: la franja, el menú, los sockets). */
export function setPractice(next: boolean): void {
  if (next === on) return;
  on = next;
  try {
    if (next) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    // Sin sessionStorage (modo privado): solo vale en memoria.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** En una pantalla: ¿está la práctica encendida? (en el servidor, siempre no). */
export function usePractice(): boolean {
  return useSyncExternalStore(subscribe, isPractice, () => false);
}
