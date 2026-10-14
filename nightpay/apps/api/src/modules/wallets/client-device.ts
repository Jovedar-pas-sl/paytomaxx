import { createHash, randomBytes } from 'node:crypto';

/**
 * El móvil del cliente. No se puede leer la MAC (ni web ni apps: los móviles
 * la ocultan y la cambian en cada wifi), así que cada móvil lleva una llave
 * aleatoria propia en su navegador (cookie __Host-np_dev, HttpOnly) y la base solo
 * guarda su sha256. Con ella:
 *  - el saldo queda "en este móvil" (el primero que lo abre),
 *  - /w sin enlace lleva a su saldo, y la página de un cobro le avisa de que
 *    tiene saldo,
 *  - Face ID / huella (WebAuthn) se registra para el móvil y protege todos
 *    sus saldos.
 */

/**
 * En producción con el prefijo __Host- (Secure, Path=/, sin Domain): ningún
 * otro subdominio puede ponerla ni pisarla. En http (desarrollo) el navegador
 * no admite ese prefijo.
 */
export function deviceCookieName(production: boolean = isProduction()): string {
  return production ? '__Host-np_dev' : 'np_dev';
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Chrome no guarda cookies más de 400 días. */
export const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** La llave del móvil, si la cabecera Cookie la trae bien formada. */
export function readDeviceToken(cookieHeader: string | undefined, production: boolean = isProduction()): string | null {
  const name = `${deviceCookieName(production)}=`;
  for (const part of (cookieHeader ?? '').split(';')) {
    const c = part.trim();
    if (!c.startsWith(name)) continue;
    const value = c.slice(name.length);
    if (DEVICE_TOKEN.test(value)) return value;
  }
  return null;
}

/** Path=/: la usan /w (su saldo) y /pay (el aviso "tienes saldo"). */
export function deviceCookieHeader(token: string, production: boolean = isProduction()): string {
  const site = production ? 'Secure; SameSite=Lax' : 'SameSite=Lax';
  return `${deviceCookieName(production)}=${token}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; ${site}`;
}

/**
 * Dónde vale Face ID / huella. El navegador ata la llave al dominio de la
 * página (rpID) y firma su origen: solo se aceptan los nuestros. Si la marca
 * cambia de dominio, los clientes vuelven a activarlo (sus saldos no se
 * pierden: sin llave registrada, el saldo funciona como siempre).
 */
export function relyingParty(
  host: string | undefined,
  env: { apiUrl?: string; webClientUrl?: string; production: boolean },
): { rpID: string; origins: string[] } {
  const origins = [env.apiUrl, env.webClientUrl]
    .map((u) => originOf(u))
    .filter((o): o is string => o !== null);
  if (!env.production) origins.push('http://localhost:4100', 'http://127.0.0.1:4100');
  const unique = [...new Set(origins)];
  const fromHost = host ? unique.find((o) => new URL(o).host === host.toLowerCase()) : undefined;
  const chosen = fromHost ?? unique[0] ?? 'http://localhost:4100';
  return { rpID: new URL(chosen).hostname, origins: unique };
}

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withProto).origin;
  } catch {
    return null;
  }
}
