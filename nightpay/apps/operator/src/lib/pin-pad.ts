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

// ─── Lo que lee el cliente en el móvil del personal ──────────────────
// Una línea en inglés detrás, para quien no lee español (auditoría PS-A10).
// Y la verdad sobre el PIN (PS-A2 / S-3): antes decía «No se guarda en ningún
// sitio», y sí se guarda (cifrado): lo que importa es que nadie lo ve.

/** Un texto para el cliente, en español y con su línea en inglés. */
export interface ClientText {
  es: string;
  en: string;
}

export const PIN_ENTER: ClientText = { es: 'Pon tu PIN', en: 'Enter your PIN' };
export const PIN_CHOOSE: ClientText = { es: 'Elige un PIN de 4 cifras', en: 'Choose a 4-digit PIN' };
export const PIN_REPEAT: ClientText = { es: 'Repite el PIN', en: 'Enter it again' };

/** Al elegir su PIN. */
export const PIN_CHOOSE_HINT: ClientText = {
  es: 'Tápalo con la mano y no lo digas en voz alta. Nadie del local puede verlo después.',
  en: 'Cover it with your hand. Nobody here can see it afterwards.',
};

/** El cobro abierto, para el cliente: lo que dice el título en español. */
export const WAIT_TITLE_EN = {
  nfc: 'Hold your tag to the phone or scan the QR',
  qr: 'Scan the QR with your phone',
} as const;

/** En CARGADO, junto al QR de activación (PS-A12). */
export const ACTIVATION_FOR_CLIENT: ClientText = {
  es: 'Para ti: escanéalo y verás tu saldo en tu móvil',
  en: 'Scan to see your balance on your phone',
};
