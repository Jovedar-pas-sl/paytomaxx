import type { PinKeypadLayout } from '@nightpay/contracts';

/** El teclado de siempre (1-9 y el 0 abajo): de fábrica, más fácil a oscuras. */
export const FIXED_DIGITS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** Las cifras del teclado según el local (Ajustes → Noche): fijas o desordenadas. */
export function keypadDigits(layout: PinKeypadLayout, randomInt?: (max: number) => number): string[] {
  return layout === 'shuffled' ? shuffledDigits(randomInt) : [...FIXED_DIGITS];
}

/**
 * Las cifras del teclado del PIN, en otro orden cada vez: quien mira dónde
 * pulsa el cliente (la chica que le sostiene el móvil) no saca el PIN.
 */
export function shuffledDigits(randomInt: (max: number) => number = cryptoRandomInt): string[] {
  const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (let i = digits.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [digits[i], digits[j]] = [digits[j]!, digits[i]!];
  }
  return digits;
}

/** Entero al azar en [0, max) sin sesgo, con el generador seguro del navegador. */
function cryptoRandomInt(max: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  let x: number;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % max;
}
