/**
 * Cookies a mano (sin @fastify/cookie): leer una de la cabecera Cookie y
 * escribir un Set-Cookie. Lo mismo que ya hacía la cookie del pago del cliente.
 */

/** Valor de la cookie `name` en la cabecera Cookie (la primera si hay varias); null si no está. */
export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  const prefix = `${name}=`;
  for (const part of raw.split(';')) {
    const c = part.trim();
    if (c.startsWith(prefix)) return c.slice(prefix.length);
  }
  return null;
}

export interface CookieAttributes {
  readonly path: string;
  /** Segundos; 0 = borrarla. */
  readonly maxAgeSeconds: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None';
}

/** Set-Cookie sin Domain: la cookie es solo de este host (no de los subdominios hermanos). */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  return [
    `${name}=${value}`,
    `Path=${attrs.path}`,
    `Max-Age=${Math.max(0, Math.floor(attrs.maxAgeSeconds))}`,
    ...(attrs.httpOnly ? ['HttpOnly'] : []),
    ...(attrs.secure ? ['Secure'] : []),
    `SameSite=${attrs.sameSite}`,
  ].join('; ');
}
