import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * «Mi QR» de la chica («Invitar a una copa»): un token firmado y de vida
 * corta que solo dice qué persona del personal es (y de qué local). No es una
 * credencial: no abre su sesión ni cobra nada; el camarero lo escanea para
 * apuntar a quién invita el cliente. Se firma con una clave derivada de
 * JWT_SECRET (otra clave distinta de la de las sesiones).
 *
 *   <payload en base64url>.<firma en base64url>, payload = { u, t, e }
 */

/** Lo que dura un QR: la app lo renueva antes (cada pocos minutos). */
export const STAFF_QR_TTL_MS = 10 * 60 * 1000;

interface Payload {
  /** La persona (users.id). */
  u: string;
  /** Su local. */
  t: string;
  /** Caduca (ms desde 1970). */
  e: number;
}

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('nightpay:staff-qr:v1').digest();
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(payloadB64).digest('base64url');
}

/** La clave del servidor (sin ella no se firma ni se acepta ningún QR). */
export function staffQrSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET no configurada: no se puede firmar el QR del personal');
  return secret;
}

export function signStaffToken(who: { userId: string; tenantId: string }, now: number, secret: string): { token: string; expiresAt: Date } {
  const payload: Payload = { u: who.userId, t: who.tenantId, e: now + STAFF_QR_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${body}.${sign(body, secret)}`, expiresAt: new Date(payload.e) };
}

/** De quién es el QR, si la firma vale y no ha caducado (si no, null). */
export function verifyStaffToken(token: string, now: number, secret: string): { userId: string; tenantId: string } | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
    if (typeof p.u !== 'string' || typeof p.t !== 'string' || typeof p.e !== 'number' || p.e <= now) return null;
    return { userId: p.u, tenantId: p.t };
  } catch {
    return null;
  }
}
