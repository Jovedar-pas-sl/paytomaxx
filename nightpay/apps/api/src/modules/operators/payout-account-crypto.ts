import { deriveKey, openText, sealText } from '../auth/aes-gcm';

/**
 * La cuenta de cobro del personal (users.payoutAddress) y su titular
 * (payoutMetadata.accountHolder) se guardan cifrados con AES-256-GCM y una
 * clave derivada de ENCRYPTION_KEK, que no está en la base: con una copia de
 * la base no se ven las cuentas.
 *
 *   pa1:<nonce>:<cifrado>:<tag>   (base64url)
 *   clave = HMAC-SHA256(ENCRYPTION_KEK, "nightpay:payout-account:v1")
 *   datos autenticados = "pa1:<campo>:<persona>": copiada a otra persona o a
 *   otro campo, no se abre.
 *
 * Un valor sin el prefijo es uno antiguo en claro: se lee tal cual (hasta que
 * el relleno de payout-account-backfill lo cifre). Si se cambia ENCRYPTION_KEK,
 * las cuentas guardadas ya no se pueden ver: hay que volver a ponerlas.
 */
const PREFIX = 'pa1';
const KEY_PURPOSE = 'nightpay:payout-account:v1';
const MIN_KEK_LENGTH = 32;

export type PayoutSecretField = 'address' | 'holder';

export interface PayoutSecretRef {
  /** La persona dueña de la cuenta (users.id). */
  userId: string;
  field: PayoutSecretField;
}

export function isSealedPayoutValue(stored: string): boolean {
  return stored.startsWith(`${PREFIX}:`);
}

export function sealPayoutValue(plaintext: string, ref: PayoutSecretRef, kek: string | undefined = process.env.ENCRYPTION_KEK): string {
  return `${PREFIX}:${sealText(keyOf(kek), plaintext, aadOf(ref))}`;
}

/** En claro (solo en memoria). Lanza si está cifrada y la clave o la persona no son las suyas. */
export function openPayoutValue(stored: string, ref: PayoutSecretRef, kek: string | undefined = process.env.ENCRYPTION_KEK): string {
  if (!isSealedPayoutValue(stored)) return stored;
  return openText(keyOf(kek), stored.slice(PREFIX.length + 1), aadOf(ref));
}

const aadOf = (ref: PayoutSecretRef): string => `${PREFIX}:${ref.field}:${ref.userId}`;

function keyOf(kek: string | undefined): Buffer {
  if (!kek || kek.length < MIN_KEK_LENGTH) {
    throw new Error('ENCRYPTION_KEK no configurada: no se puede cifrar ni leer la cuenta de cobro');
  }
  return deriveKey(kek, KEY_PURPOSE);
}
