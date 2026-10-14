import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * PIN del saldo: 4 cifras que elige y teclea solo el cliente. Con su código o
 * su pulsera, la chica cobra; sin el PIN, el código no sirve de nada.
 *
 * Nunca se guarda en claro: HMAC con una clave del servidor (ENCRYPTION_KEK,
 * que no está en la base) y después scrypt con sal propia. Con solo una copia
 * de la base no se pueden probar las 10.000 combinaciones.
 */

const scrypt = promisify(scryptCb) as (pw: Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

/** Tras 5 PIN fallidos el saldo queda bloqueado hasta que lo desbloquee el encargado. */
export const PIN_MAX_FAILS = 5;

/** Los PIN que cualquiera prueba primero no valen. */
const OBVIOUS = new Set(['1234', '4321', '0123', '3210', '1212', '2580', '1004', '2000', '1122', '6969']);

export type PinProblem = 'format' | 'obvious';

/** null si vale; si no, por qué. */
export function pinProblem(pin: string): PinProblem | null {
  if (!/^\d{4}$/.test(pin)) return 'format';
  if (/^(\d)\1{3}$/.test(pin) || OBVIOUS.has(pin)) return 'obvious';
  return null;
}

export const PIN_PROBLEM_TEXT: Record<PinProblem, string> = {
  format: 'El PIN son 4 cifras',
  obvious: 'Ese PIN es demasiado fácil de adivinar: elige otro',
};

export async function hashPin(pin: string, pepper: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(peppered(pin, pepper), salt, KEY_LEN, SCRYPT);
  return `s1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPin(pin: string, stored: string, pepper: string): Promise<boolean> {
  const [version, saltB64, keyB64] = stored.split('$');
  if (version !== 's1' || !saltB64 || !keyB64 || !/^\d{4}$/.test(pin)) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(peppered(pin, pepper), Buffer.from(saltB64, 'base64url'), expected.length, SCRYPT);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function peppered(pin: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(`wallet-pin:${pin}`).digest();
}

/**
 * La pulsera o tarjeta NFC: su número de serie (Web NFC lo da como
 * "04:a2:3b:…"). Se guarda en mayúsculas, sin separadores.
 */
export function normalizeNfcTag(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length >= 8 && hex.length <= 32 ? hex : null;
}
