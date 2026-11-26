import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from '../auth/aes-gcm';

/**
 * La clave de API de Yavin de cada local, en gateway_credentials (provider
 * YAVIN), cifrada AES-256-GCM como las demás: encKey (cifrado), encNonce y
 * encTag, con una clave derivada de ENCRYPTION_KEK (que no está en la base).
 * El local va en los datos autenticados: una fila copiada a otro local no se
 * abre. La clave en claro nunca sale de aquí hacia logs ni respuestas.
 */
const KEY_PURPOSE = 'nightpay:gateway-credential:yavin:v1';
const MIN_KEK_LENGTH = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const YAVIN_KEK_VERSION = 1;

export interface SealedCredential {
  encKey: Buffer;
  encNonce: Buffer;
  encTag: Buffer;
  kekVersion: number;
}

function keyOf(kek: string | undefined): Buffer {
  if (!kek || kek.length < MIN_KEK_LENGTH) throw new Error('ENCRYPTION_KEK no configurada: no se puede cifrar ni leer la clave de Yavin');
  return deriveKey(kek, KEY_PURPOSE);
}

const aad = (tenantId: string): Buffer => Buffer.from(`yavin:apikey:${tenantId}`, 'utf8');

export function sealYavinKey(kek: string | undefined, tenantId: string, apiKey: string): SealedCredential {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyOf(kek), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(tenantId));
  const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return { encKey: enc, encNonce: nonce, encTag: cipher.getAuthTag(), kekVersion: YAVIN_KEK_VERSION };
}

/** Lanza si la KEK no es la buena, la fila es de otro local o se ha tocado. */
export function openYavinKey(
  kek: string | undefined,
  tenantId: string,
  row: { encKey: Uint8Array; encNonce: Uint8Array; encTag: Uint8Array },
): string {
  const decipher = createDecipheriv('aes-256-gcm', keyOf(kek), Buffer.from(row.encNonce), { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(tenantId));
  decipher.setAuthTag(Buffer.from(row.encTag));
  return Buffer.concat([decipher.update(Buffer.from(row.encKey)), decipher.final()]).toString('utf8');
}
