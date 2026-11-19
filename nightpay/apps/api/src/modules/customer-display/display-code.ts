import { randomBytes, randomInt } from 'node:crypto';
import { CUSTOMER_DISPLAY_CODE_ALPHABET, CUSTOMER_DISPLAY_CODE_LENGTH } from '@nightpay/contracts';

export { normalizePairingCode as normalizeDisplayCode, sha256 } from '../pos-device/paytef';

/** Código corto que enseña la app del personal y se teclea en la tablet («K7P4QX»). */
export function newDisplayCode(): string {
  return Array.from(
    { length: CUSTOMER_DISPLAY_CODE_LENGTH },
    () => CUSTOMER_DISPLAY_CODE_ALPHABET[randomInt(CUSTOMER_DISPLAY_CODE_ALPHABET.length)],
  ).join('');
}

/** «K7P4QX» → «K7P-4QX», para leerlo mejor. */
export function formatDisplayCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** Credencial de la tablet: se entrega una vez y solo se guarda su huella. */
export function newDisplayToken(): string {
  return randomBytes(32).toString('base64url');
}
