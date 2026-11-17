import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * El enlace «No he sido yo» del aviso de cada cobro (/w/no/<token>): un
 * token firmado y con caducidad que solo vale para ESE cobro de ESE saldo.
 *
 *   <payload en base64url>.<firma en base64url>, payload = { c, e }
 *
 *  - c: el cobro del saldo (wallet_charge_requests.id); e: caduca (ms).
 *  - La firma cubre también el saldo del cobro, que NO va en el enlace: el
 *    servidor lo saca del cobro. Con el token de un cobro no se toca otro
 *    saldo, y en la URL no va nada del cliente (ni su saldo, ni su código).
 *  - Clave derivada de JWT_SECRET (distinta de la de las sesiones).
 *  - Se gasta una vez: el cobro queda marcado como «no he sido yo».
 */

/** Lo que vale el enlace: el cliente puede ver el aviso a la mañana siguiente. */
export const NOT_ME_TTL_MS = 72 * 60 * 60 * 1000;

/** Forma del token (antes de tocar la base): dos trozos base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}\.[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Payload {
  c: string;
  e: number;
}

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('nightpay:aviso-cobro:no-he-sido-yo:v1').digest();
}

function sign(walletId: string, body: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(`${walletId.toLowerCase()}.${body}`).digest('base64url');
}

/** La clave del servidor (sin ella no se firma ni se acepta ningún enlace). */
export function notMeSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET no configurada: no se puede firmar «No he sido yo»');
  return secret;
}

export function signNotMeToken(charge: { chargeId: string; walletId: string }, now: number, secret: string): string {
  const payload: Payload = { c: charge.chargeId.toLowerCase(), e: now + NOT_ME_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(charge.walletId, body, secret)}`;
}

/**
 * El cobro que dice el token, SIN comprobar la firma (para buscar su saldo en
 * la base). null si no tiene la forma. Siempre después: verifyNotMeToken.
 */
export function notMeChargeId(token: unknown): string | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Partial<Payload>;
    return typeof p.c === 'string' && UUID_RE.test(p.c) ? p.c.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type NotMeCheck = 'ok' | 'invalid' | 'expired';

/** ¿Lo firmó el servidor para este cobro de este saldo y sigue vigente? (comparación de tiempo constante) */
export function verifyNotMeToken(token: string, walletId: string, now: number, secret: string): NotMeCheck {
  if (!TOKEN_RE.test(token)) return 'invalid';
  const [body, sig] = token.split('.') as [string, string];
  const expected = Buffer.from(sign(walletId, body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
    if (typeof p.c !== 'string' || typeof p.e !== 'number') return 'invalid';
    return p.e <= now ? 'expired' : 'ok';
  } catch {
    return 'invalid';
  }
}

/** /w/no/<token>: lo que abre el aviso (con el origen del API delante). */
export function notMePath(token: string): string {
  return `/w/no/${token}`;
}
