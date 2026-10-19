import { isValidCutoff, parseCutoff } from './date-cutoff';

/**
 * Sesión del personal: el refresh token en el CUERPO de la petición (apps
 * antiguas en caché, que lo guardaban en localStorage). Las apps nuevas lo
 * llevan en una cookie HttpOnly y no lo ven nunca. Hasta la fecha de corte:
 *   - POST /v1/auth/refresh y /logout aceptan { refreshToken } en el cuerpo;
 *   - POST /v1/auth/login lo sigue devolviendo a las apps antiguas.
 * Después solo vale la cookie (la app antigua pide entrar otra vez y, al
 * recargar, ya es la nueva). Cerrar sesión con el token del cuerpo se acepta
 * siempre: solo revoca.
 *
 * AUTH_BODY_REFRESH_UNTIL (opcional):
 *   - sin definir o vacía → AUTH_BODY_REFRESH_DEFAULT_UNTIL
 *   - fecha y hora ISO con zona (p. ej. 2026-12-15T00:00:00+01:00) → hasta entonces
 *   - "off" → cerrada ya
 * Antes de la fecha, nightpay_auth_body_refresh_total{client="legacy"} debería
 * haber dejado de subir.
 */
/** Martes a mediodía (Madrid): ni en plena noche de cobro ni en fin de semana. */
export const AUTH_BODY_REFRESH_DEFAULT_UNTIL = '2026-12-01T12:00:00+01:00';

export const AUTH_BODY_REFRESH_UNTIL_HINT =
  'Fecha y hora ISO con zona (p. ej. 2026-12-01T12:00:00+01:00) u "off" para cerrarla ya';

export function isValidAuthBodyRefreshUntil(raw: string | undefined): boolean {
  return isValidCutoff(raw);
}

/** Hasta cuándo vale el refresh token en el cuerpo; null = ya no. Lanza si el valor no vale. */
export function authBodyRefreshUntil(raw: string | undefined): Date | null {
  return parseCutoff(raw, {
    defaultUntil: AUTH_BODY_REFRESH_DEFAULT_UNTIL,
    envVar: 'AUTH_BODY_REFRESH_UNTIL',
    hint: AUTH_BODY_REFRESH_UNTIL_HINT,
  });
}
