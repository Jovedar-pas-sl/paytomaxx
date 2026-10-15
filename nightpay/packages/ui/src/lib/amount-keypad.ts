// Teclado de importe: las cifras entran por la derecha en céntimos, como en un
// datáfono ("5", "0", "0", "0" → 50,00 €). Sin coma que buscar ni teclado del
// sistema que tape la pantalla. Siempre en el mismo orden (el del PIN no).

export type KeypadDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type KeypadKey = KeypadDigit | '00' | 'back' | 'clear';

/** 3×4, de arriba abajo: 1 2 3 · 4 5 6 · 7 8 9 · 00 0 ⌫. */
export const KEYPAD_LAYOUT: readonly KeypadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];

/** Tope por defecto: 100.000 € (el mismo que MAX_TYPED_AMOUNT_CENTS de @nightpay/contracts). */
export const DEFAULT_KEYPAD_MAX_CENTS = 10_000_000;

const DIGITS = new Set<string>(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

function isDigit(key: string): key is KeypadDigit {
  return DIGITS.has(key);
}

/**
 * El importe tras pulsar una tecla. Una cifra que pasaría del tope no entra
 * (el importe se queda como estaba).
 */
export function pressKeypad(cents: number, key: KeypadKey, maxCents: number = DEFAULT_KEYPAD_MAX_CENTS): number {
  const current = Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
  let next: number;
  if (key === 'back') next = Math.floor(current / 10);
  else if (key === 'clear') next = 0;
  else if (key === '00') next = current * 100;
  else next = current * 10 + Number(key);
  return next > maxCents ? current : next;
}

/** Tecla del teclado físico (TPV de sobremesa) → tecla del teclado de importe; null si no es ninguna. */
export function keypadKeyFromKeyboard(key: string): KeypadKey | null {
  if (isDigit(key)) return key;
  if (key === 'Backspace') return 'back';
  if (key === 'Delete') return 'clear';
  return null;
}

/** Nombre de la tecla para el lector de pantalla. */
export function keypadKeyLabel(key: KeypadKey): string {
  if (key === 'back') return 'Borrar';
  if (key === 'clear') return 'Borrar todo';
  if (key === '00') return 'Dos ceros';
  return key;
}
