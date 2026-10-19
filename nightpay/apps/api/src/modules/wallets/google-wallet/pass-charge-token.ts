import { createHmac, timingSafeEqual } from 'node:crypto';
import { linkHash } from './google-wallet-pass';

/**
 * El QR del pase de Google Wallet: solo para COBRAR en el datáfono (el
 * cliente teclea su PIN), nunca el enlace del saldo (/w/<token>), que da
 * todos los poderes (elegir PIN, «Me voy», activar SU Face ID, sumarlo a otro
 * saldo). Un móvil del personal que lo lea no abre nada.
 *
 * Token = id del saldo (16 bytes) + HMAC del id y del hash de su enlace
 * actual (16 bytes), en base64url (43 caracteres). Sin columna nueva: si el
 * dueño da un enlace nuevo al saldo, el token viejo deja de valer (y el
 * repaso apaga el pase viejo). La clave es COOKIE_SECRET (con su contexto).
 */
export const PASS_CHARGE_SEGMENT = 'c';
const ID_BYTES = 16;
const MAC_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La clave del servidor (la misma al hacer el pase y al cobrar con él). */
export function passChargeSecret(): string {
  return process.env.COOKIE_SECRET ?? '';
}

function mac(secret: string, walletId: string, qrToken: string): Buffer {
  return createHmac('sha256', secret)
    .update(`np-pass-charge:v1:${walletId.toLowerCase()}:${linkHash(qrToken)}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

export function passChargeToken(secret: string, walletId: string, qrToken: string): string {
  if (!UUID_RE.test(walletId)) throw new Error('El id del saldo no es un UUID');
  const id = Buffer.from(walletId.replace(/-/g, ''), 'hex');
  return Buffer.concat([id, mac(secret, walletId, qrToken)]).toString('base64url');
}

/** https://api.dominio/c/<token>: lo que va en el código de barras del pase. */
export function passChargeUrl(origin: string, secret: string, walletId: string, qrToken: string): string {
  return `${origin}/${PASS_CHARGE_SEGMENT}/${passChargeToken(secret, walletId, qrToken)}`;
}

/** El saldo que dice el token (falta comprobarlo con passChargeTokenValid); null si no tiene la forma. */
export function passChargeWalletId(token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== ID_BYTES + MAC_BYTES) return null;
  const h = raw.subarray(0, ID_BYTES).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** ¿Es el token de ESTE saldo con SU enlace actual? (comparación en tiempo constante) */
export function passChargeTokenValid(secret: string, token: string, wallet: { id: string; qrToken: string }): boolean {
  if (passChargeWalletId(token)?.toLowerCase() !== wallet.id.toLowerCase()) return false;
  const got = Buffer.from(token, 'base64url').subarray(ID_BYTES);
  const expected = mac(secret, wallet.id, wallet.qrToken);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
