import { deriveKey, openText, sealText } from './aes-gcm';

/**
 * Secreto 2FA cifrado en users.totpSecret (AES-256-GCM con una clave derivada
 * de ENCRYPTION_KEK, que no está en la base): con una copia de la base no se
 * pueden generar códigos.
 *
 *   tv1:<nonce>:<cifrado>:<tag>   (base64url; AAD "tv1")
 *   clave = HMAC-SHA256(ENCRYPTION_KEK, "nightpay:totp-secret:v1")
 *
 * Un valor sin el prefijo es un secreto antiguo en claro (base32): se acepta y
 * se vuelve a guardar cifrado en el siguiente código correcto.
 *
 * OJO: `pnpm cli enroll-totp` (packages/db/scripts/cli.ts) cifra con este mismo
 * formato. Si cambias algo aquí, cámbialo allí (totp-crypto.spec lo comprueba).
 * Si se cambia ENCRYPTION_KEK, hay que volver a activar la 2FA (CLI o pantalla).
 */
const PREFIX = 'tv1';
const KEY_PURPOSE = 'nightpay:totp-secret:v1';
const MIN_KEK_LENGTH = 32;

export interface OpenedTotpSecret {
  /** Secreto base32 en claro, solo en memoria. */
  readonly secret: string;
  /** true = estaba guardado en claro (hay que re-cifrarlo). */
  readonly legacy: boolean;
}

export function isSealedTotpSecret(stored: string): boolean {
  return stored.startsWith(`${PREFIX}:`);
}

export function sealTotpSecret(secretBase32: string, kek: string | undefined): string {
  return `${PREFIX}:${sealText(totpKey(kek), secretBase32, PREFIX)}`;
}

export function openTotpSecret(stored: string, kek: string | undefined): OpenedTotpSecret {
  if (!isSealedTotpSecret(stored)) return { secret: stored, legacy: true };
  return { secret: openText(totpKey(kek), stored.slice(PREFIX.length + 1), PREFIX), legacy: false };
}

function totpKey(kek: string | undefined): Buffer {
  if (!kek || kek.length < MIN_KEK_LENGTH) {
    throw new Error('ENCRYPTION_KEK no configurada: no se puede cifrar ni leer el secreto 2FA');
  }
  return deriveKey(kek, KEY_PURPOSE);
}
