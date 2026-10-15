import { timingSafeEqual } from 'node:crypto';
import { markOriginVerified } from './client-ip';

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
const OPEN_PATHS = ['/v1/health', '/v1/health/live'];
/**
 * Los avisos del banco (Redsys, Paytef, Peanpe) se aceptan aunque no pasen
 * por Cloudflare: cada uno trae su firma o su secreto y se comprueba en el
 * controlador. Así un aviso por otra ruta (p. ej. un subdominio "DNS only"
 * si Cloudflare los bloquea) no deja cobros sin confirmar.
 */
const OPEN_PREFIXES = ['/v1/webhooks/'];

type Headers = Record<string, string | string[] | undefined>;

/** Rutas que se aceptan aunque no pasen por Cloudflare (healthcheck y avisos del banco). */
export function isOriginOpenPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return OPEN_PATHS.includes(path) || OPEN_PREFIXES.some((p) => path.startsWith(p));
}

/** ¿Trae la petición la cabecera de Cloudflare con el secreto correcto? */
export function hasOriginAuth(headers: Headers, secret: string): boolean {
  const got = headers[ORIGIN_AUTH_HEADER];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function originAllowed(headers: Headers, url: string, secret: string | undefined): boolean {
  if (!secret) return true;
  return isOriginOpenPath(url) || hasOriginAuth(headers, secret);
}

interface HookRequest {
  headers: Headers;
  url: string;
}
interface HookReply {
  code: (status: number) => { send: (body: unknown) => unknown };
}

/**
 * Hook onRequest de Fastify (main.ts, solo con ORIGIN_AUTH_SECRET): corta lo
 * que no venga de Cloudflare, marca lo que sí (entonces CF-Connecting-IP es de
 * fiar, ver client-ip.ts) y quita el secreto de la petición para que no acabe
 * en logs ni en Sentry.
 */
export function originAuthHook(secret: string) {
  return async (req: HookRequest, reply: HookReply): Promise<unknown> => {
    const verified = hasOriginAuth(req.headers, secret);
    delete req.headers[ORIGIN_AUTH_HEADER];
    if (verified) {
      markOriginVerified(req);
      return undefined;
    }
    if (isOriginOpenPath(req.url)) return undefined;
    return reply.code(403).send({ title: 'Forbidden', status: 403 });
  };
}
