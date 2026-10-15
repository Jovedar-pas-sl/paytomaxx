import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * payments.tokenizationData (token de tarjeta de Redsys para cobros
 * recurrentes, con REDSYS_REQUEST_TOKEN=true): el token reusable
 * (Ds_Merchant_Identifier) y el id de la operación original no se guardan en
 * claro. Se cifran con AES-256-GCM, como las credenciales de pasarela (CLI
 * set-credential), con una clave derivada de ENCRYPTION_KEK solo para esto.
 * Lo demás (últimos 4, marca, caducidad, fecha) queda legible.
 *
 * Guardado: { v: 1, sealed: "<iv>.<tag>.<cifrado>" (base64url), ...resto }.
 * Un valor antiguo en claro (con identifier) se devuelve tal cual al abrirlo.
 */

/** Campos que permitirían cobrar con la tarjeta: solo cifrados. */
const SECRET_FIELDS = ['identifier', 'cofTxnId'] as const;
const SEAL_VERSION = 1;

export type StoredTokenization = Record<string, unknown>;

export function sealTokenizationData(data: Record<string, unknown>, kek: string | undefined): StoredTokenization {
  const secret = Object.fromEntries(SECRET_FIELDS.filter((f) => f in data).map((f) => [f, data[f]]));
  const rest = Object.fromEntries(
    Object.entries(data).filter(([k]) => !(SECRET_FIELDS as readonly string[]).includes(k)),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(kek), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  const sealed = [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  return { ...rest, v: SEAL_VERSION, sealed };
}

/** Datos completos (con el token). Lanza si el cifrado no cuadra (clave distinta o manipulado). */
export function openTokenizationData(stored: unknown, kek: string | undefined): Record<string, unknown> | null {
  if (!stored || typeof stored !== 'object') return null;
  const { sealed, v: _v, ...rest } = stored as Record<string, unknown>;
  if (typeof sealed !== 'string') return { ...rest };
  const [iv, tag, ct] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !ct) throw new Error('tokenizationData cifrado con formato no válido');
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(kek), iv);
  decipher.setAuthTag(tag);
  const secret = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')) as Record<
    string,
    unknown
  >;
  return { ...rest, ...secret };
}

/** ¿Está cifrado? (los valores antiguos se guardaron en claro). */
export function isSealedTokenization(stored: unknown): boolean {
  return Boolean(stored && typeof stored === 'object' && typeof (stored as { sealed?: unknown }).sealed === 'string');
}

function tokenKey(kek: string | undefined): Buffer {
  if (!kek || kek.length < 32) {
    throw new Error('ENCRYPTION_KEK no configurada: no se puede cifrar el token de la tarjeta');
  }
  return createHmac('sha256', kek).update('nightpay:payments.tokenizationData:v1').digest();
}
