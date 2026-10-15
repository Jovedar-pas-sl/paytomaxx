import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Clave AES-256 para un uso concreto, derivada de un secreto con HMAC-SHA256. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(purpose).digest();
}

/** AES-256-GCM. Devuelve "<nonce>:<cifrado>:<tag>" en base64url. */
export function sealText(key: Buffer, plaintext: string, aad: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [nonce, enc, cipher.getAuthTag()].map((b) => b.toString('base64url')).join(':');
}

/** Inverso de sealText. Lanza si la clave no es la buena o el texto se ha tocado. */
export function openText(key: Buffer, sealed: string, aad: string): string {
  const [nonce, enc, tag, ...rest] = sealed.split(':').map((p) => Buffer.from(p, 'base64url'));
  if (!nonce || !enc || !tag || rest.length > 0 || nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Texto cifrado con formato desconocido');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
