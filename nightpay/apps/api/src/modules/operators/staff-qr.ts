import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * «Mi QR» de la chica («Copa con invitación»): un token firmado y de vida
 * corta que solo dice qué persona del personal es (y de qué local). No es una
 * credencial: no abre su sesión ni cobra nada; el camarero lo escanea para
 * apuntar a quién invita el cliente. Se firma con una clave derivada de
 * JWT_SECRET (otra clave distinta de la de las sesiones).
 *
 *   <payload en base64url>.<firma en base64url>, payload = { u, t, e, c? }
 *
 * El que sale de su ficha NFC (/operators/staff-card/resolve) lleva además el
 * id de esa ficha (`c`): al crear el cobro se vuelve a mirar que siga viva
 * (ni anulada ni sustituida). El de «Mi QR» no lo lleva.
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
  /** La ficha NFC de la que sale (staff_cards.id); sin él, su «Mi QR». */
  c?: string;
}

export interface StaffTokenWho {
  userId: string;
  tenantId: string;
  /** Solo si sale de su ficha NFC: la ficha que tiene que seguir viva. */
  staffCardId?: string;
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

export function signStaffToken(who: StaffTokenWho, now: number, secret: string): { token: string; expiresAt: Date } {
  const payload: Payload = { u: who.userId, t: who.tenantId, e: now + STAFF_QR_TTL_MS };
  if (who.staffCardId) payload.c = who.staffCardId;
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${body}.${sign(body, secret)}`, expiresAt: new Date(payload.e) };
}

/** De quién es el QR, si la firma vale y no ha caducado (si no, null). */
export function verifyStaffToken(token: string, now: number, secret: string): StaffTokenWho | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
    if (typeof p.u !== 'string' || typeof p.t !== 'string' || typeof p.e !== 'number' || p.e <= now) return null;
    if (p.c !== undefined && (typeof p.c !== 'string' || p.c.length === 0)) return null;
    return p.c ? { userId: p.u, tenantId: p.t, staffCardId: p.c } : { userId: p.u, tenantId: p.t };
  } catch {
    return null;
  }
}
