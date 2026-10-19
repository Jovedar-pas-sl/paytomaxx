import { serializeCookie } from '../../common/http/cookies';

/**
 * Sesión del personal en cookie (issue #65): el refresh token va en una
 * cookie HttpOnly del API y las apps no lo ven nunca (un XSS ya no se lleva
 * una sesión de 30 días). El access token vive solo en la memoria de cada
 * pestaña y se pide con esta cookie.
 *
 * Cookie: HttpOnly; Secure (producción); SameSite=Strict; sin Domain (solo
 * api.<dominio>); Path=/v1/auth; Max-Age = la del refresh token (30 días),
 * renovada en cada refresco (rotación).
 *
 * Una cookie por app: su nombre sale del Origin que la pide
 * (np_rt_admin.paytomaxx.com, np_rt_operator.paytomaxx.com…). Así entrar en
 * el TPV no pisa la sesión del panel en el mismo navegador, y un fallo en una
 * app no puede pedir la sesión de otra (el navegador fija el Origin, no el script).
 *
 * Contra CSRF, lo que usa la cookie (refresh, logout y el login que la pone)
 * exige las dos cosas, o 403:
 *   - Origin exacto de CORS_ORIGINS (en local sin lista, cualquiera bien formado);
 *   - la cabecera X-OxioPay-Client: 1 (cabecera propia: obliga al preflight).
 */
export const STAFF_CLIENT_HEADER = 'x-oxiopay-client';
export const STAFF_CLIENT_VALUE = '1';
export const REFRESH_COOKIE_PATH = '/v1/auth';
export const REFRESH_COOKIE_PREFIX = 'np_rt_';

type Headers = Record<string, string | string[] | undefined>;

export interface CookieSessionPolicy {
  /** CORS_ORIGINS ya partido. */
  readonly allowedOrigins: readonly string[];
  readonly isProd: boolean;
}

export type CsrfCheck = { ok: true; origin: string } | { ok: false; reason: 'client-header' | 'origin' };

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

/** ¿La petición dice ser de una app nueva (cabecera propia)? */
export function hasStaffClientHeader(headers: Headers): boolean {
  return single(headers[STAFF_CLIENT_HEADER]) === STAFF_CLIENT_VALUE;
}

/** El Origin si es un origen http(s) bien escrito (tal cual lo serializa el navegador); si no, null. */
export function wellFormedOrigin(raw: string | undefined): string | null {
  if (!raw || raw === 'null') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

/** Cabecera propia + Origin exacto de la lista (ver arriba). */
export function checkCookieCsrf(headers: Headers, policy: CookieSessionPolicy): CsrfCheck {
  if (!hasStaffClientHeader(headers)) return { ok: false, reason: 'client-header' };
  const origin = wellFormedOrigin(single(headers.origin));
  if (!origin) return { ok: false, reason: 'origin' };
  const list = policy.allowedOrigins;
  const allowed = list.length > 0 ? list.includes(origin) : !policy.isProd;
  return allowed ? { ok: true, origin } : { ok: false, reason: 'origin' };
}

/** Nombre de la cookie de la app de ese Origin: np_rt_ + host[:puerto] con lo raro cambiado por _. */
export function refreshCookieName(origin: string): string {
  return `${REFRESH_COOKIE_PREFIX}${new URL(origin).host.replace(/[^A-Za-z0-9.-]/g, '_')}`;
}

export function refreshCookie(name: string, token: string, maxAgeSeconds: number, secure: boolean): string {
  return serializeCookie(name, token, {
    path: REFRESH_COOKIE_PATH,
    maxAgeSeconds,
    httpOnly: true,
    secure,
    sameSite: 'Strict',
  });
}

/** La misma cookie caducada (mismo nombre y Path, sin Domain): el navegador la borra. */
export function clearedRefreshCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', {
    path: REFRESH_COOKIE_PATH,
    maxAgeSeconds: 0,
    httpOnly: true,
    secure,
    sameSite: 'Strict',
  });
}
