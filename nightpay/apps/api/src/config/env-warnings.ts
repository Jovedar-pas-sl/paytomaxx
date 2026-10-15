import type { Env } from './env';

/**
 * Avisos de arranque: configuraciones que no impiden arrancar (tumbar
 * producción sería peor) pero que el dueño debe corregir. main.ts los
 * escribe en el log al arrancar.
 */
const MIN_PAYTEF_SECRET_LENGTH = 32;

type Check = (env: Env) => string | null;

const PRODUCTION_CHECKS: ReadonlyArray<Check> = [
  (env) =>
    env.REDSYS_MERCHANT_CODE && env.REDSYS_API_URL.includes('sis-t.')
      ? 'REDSYS_API_URL apunta al sandbox de Redsys (sis-t) o no está definida: los cobros reales no funcionarán. Ponla a https://sis.redsys.es/sis/realizarPago.'
      : null,
  (env) =>
    env.ORIGIN_AUTH_SECRET
      ? null
      : 'ORIGIN_AUTH_SECRET no está definido: el servidor acepta peticiones que no pasan por Cloudflare y la IP del cliente se deduce de los rangos de Cloudflare. Configúralo (regla de transformación X-Origin-Auth).',
  (env) =>
    env.METRICS_TOKEN
      ? null
      : 'METRICS_TOKEN no está definido: /v1/metrics queda cerrado para todos (también para el scrape interno).',
  (env) =>
    env.DEBUG_ENDPOINTS_ENABLED
      ? 'DEBUG_ENDPOINTS_ENABLED=true: los endpoints /v1/debug/* están abiertos para el superadmin. Vuelve a ponerlo a false al terminar.'
      : null,
];

const ALWAYS_CHECKS: ReadonlyArray<Check> = [
  (env) =>
    env.PAYTEF_WEBHOOK_SECRET && env.PAYTEF_WEBHOOK_SECRET.length < MIN_PAYTEF_SECRET_LENGTH
      ? `PAYTEF_WEBHOOK_SECRET es corto (< ${MIN_PAYTEF_SECRET_LENGTH} caracteres): genera uno con \`openssl rand -hex 32\`.`
      : null,
  (env) => invalidUrlWarning('NEXT_PUBLIC_OPERATOR_URL', env.NEXT_PUBLIC_OPERATOR_URL),
  (env) => invalidUrlWarning('NEXT_PUBLIC_WEB_CLIENT_URL', env.NEXT_PUBLIC_WEB_CLIENT_URL),
  (env) =>
    env.PASSKEY_RP_ID && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(env.PASSKEY_RP_ID)
      ? 'PASSKEY_RP_ID no parece un dominio (p. ej. paytomaxx.com, sin https:// ni barras).'
      : null,
];

function invalidUrlWarning(key: string, value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : `${key} no es una dirección http(s).`;
  } catch {
    return `${key} no es una dirección válida (falta https://?).`;
  }
}

export function envWarnings(env: Env): string[] {
  const checks = env.NODE_ENV === 'production' ? [...PRODUCTION_CHECKS, ...ALWAYS_CHECKS] : ALWAYS_CHECKS;
  return checks.map((check) => check(env)).filter((w): w is string => w !== null);
}
