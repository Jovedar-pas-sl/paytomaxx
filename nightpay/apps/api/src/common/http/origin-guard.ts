import { timingSafeEqual } from 'node:crypto';

/**
 * Que al servidor solo se llegue a través de Cloudflare.
 *
 * El servidor responde también si se le habla directamente por su IP, y
 * entonces cualquiera puede inventarse la cabecera CF-Connecting-IP (con la
 * que se cuentan los intentos de login, de códigos de saldo…). Con
 * ORIGIN_AUTH_SECRET, Cloudflare añade a cada petición la cabecera
 * X-Origin-Auth con ese secreto (regla de transformación) y aquí se rechaza
 * lo que llegue sin ella. Sin la variable, no cambia nada.
 */
export const ORIGIN_AUTH_HEADER = 'x-origin-auth';

/** El healthcheck de Docker llega desde dentro del contenedor, sin Cloudflare. */
const OPEN_PATHS = ['/v1/health'];
/**
 * Los avisos del banco (Redsys, Paytef, Peanpe) se aceptan aunque no pasen
 * por Cloudflare: cada uno trae su firma o su secreto y se comprueba en el
 * controlador. Así un aviso por otra ruta (p. ej. un subdominio "DNS only"
 * si Cloudflare los bloquea) no deja cobros sin confirmar.
 */
const OPEN_PREFIXES = ['/v1/webhooks/'];

export function originAllowed(
  headers: Record<string, string | string[] | undefined>,
  url: string,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  const path = url.split('?')[0] ?? url;
  if (OPEN_PATHS.includes(path) || OPEN_PREFIXES.some((p) => path.startsWith(p))) return true;
  const got = headers[ORIGIN_AUTH_HEADER];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
