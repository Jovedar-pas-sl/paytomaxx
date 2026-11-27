import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * El código que se graba en la ficha NFC de la compañera lo da el servidor
 * antes de grabarla (como el de las fichas de los clientes: «Preparar
 * fichas»), ya ligado a ella y a su local: 8 bytes al azar + 8 de firma
 * (HMAC con una clave derivada de JWT_SECRET), 22 caracteres base64url, el
 * mismo formato que las fichas. Así, si la grabación sale bien y se pierde la
 * respuesta al darla, la ficha no queda inservible: al acercarla otra vez se
 * lee el código ya grabado y se le da (solo a ella: el de otra no vale).
 */
const RANDOM_BYTES = 8;
const MAC_BYTES = 8;

function mac(secret: string, who: { tenantId: string; userId: string }, random: Buffer): Buffer {
  const key = createHmac('sha256', secret).update('nightpay:staff-card-code:v1').digest();
  return createHmac('sha256', key).update(`${who.tenantId}:${who.userId}:`).update(random).digest().subarray(0, MAC_BYTES);
}

export function mintStaffCardCode(who: { tenantId: string; userId: string }, secret: string): string {
  const random = randomBytes(RANDOM_BYTES);
  return Buffer.concat([random, mac(secret, who, random)]).toString('base64url');
}

/** ¿Este código lo dio el servidor para esta compañera de este local? */
export function isStaffCardCodeFor(code: string, who: { tenantId: string; userId: string }, secret: string): boolean {
  const raw = Buffer.from(code, 'base64url');
  if (raw.length !== RANDOM_BYTES + MAC_BYTES || raw.toString('base64url') !== code) return false;
  const random = raw.subarray(0, RANDOM_BYTES);
  return timingSafeEqual(raw.subarray(RANDOM_BYTES), mac(secret, who, random));
}
