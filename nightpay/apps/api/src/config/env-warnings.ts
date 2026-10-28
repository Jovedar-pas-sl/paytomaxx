import type { Env } from './env';
import { googleWalletWarning } from './google-wallet';

/**
 * Avisos de arranque: configuraciones que no impiden arrancar (tumbar
 * producción sería peor) pero que el dueño debe corregir. main.ts los
 * escribe en el log al arrancar.
 */
const MIN_PAYTEF_SECRET_LENGTH = 32;

type Check = (env: Env) => string | null;

/**
 * Tareas que apaga un NIGHTPAY_DISABLE_*=1 (pensado para desarrollo y
 * pruebas). En producción, cada una apagada da un aviso al arrancar.
 */
export const DISABLE_FLAGS = {
  NIGHTPAY_DISABLE_ALERTS:
    'los avisos por Telegram: incidencias, resumen de la mañana, los «Por aprobar» al dueño y la 2FA activada de un super-admin',
  NIGHTPAY_DISABLE_NIGHT_AUTOCLOSE: 'el cierre automático de las noches',
  NIGHTPAY_DISABLE_GOOGLE_WALLET_SYNC: 'la puesta al día de los pases de Google Wallet',
  NIGHTPAY_DISABLE_WEBHOOK_SWEEP: 'el repaso cada hora de los avisos de la pasarela que no se llegaron a procesar',
  NIGHTPAY_DISABLE_REFUND_SWEEP: 'el reintento del descuento a la chica de las devoluciones hechas',
  NIGHTPAY_DISABLE_OXIOPAY_SETTLEMENTS:
    'la «Liquidación OxioPay» del lunes (lo que cada local debe a OxioPay) y su aviso de las que llevan más de 7 días sin pagar',
} as const satisfies Partial<Record<keyof Env, string>>;

const DISABLE_CHECKS: ReadonlyArray<Check> = (Object.keys(DISABLE_FLAGS) as Array<keyof typeof DISABLE_FLAGS>).map(
  (key) => (env) =>
    env[key]?.trim() === '1' ? `${key}=1: está apagado ${DISABLE_FLAGS[key]}. Quítala en producción.` : null,
);

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
  ...DISABLE_CHECKS,
];

const ALWAYS_CHECKS: ReadonlyArray<Check> = [
  (env) =>
    env.PAYTEF_API_TOKEN && !env.PAYTEF_WEBHOOK_SECRET
      ? 'PAYTEF_WEBHOOK_SECRET no está definido con Paytef activo: los avisos de Paytef se rechazan y los cobros solo se confirman al consultarlos.'
      : null,
  (env) =>
    env.PAYTEF_FORCE_TEST !== undefined && env.PAYTEF_FORCE_TEST !== 'true' && env.PAYTEF_FORCE_TEST !== 'false'
      ? 'PAYTEF_FORCE_TEST solo admite "true" o "false" (en minúsculas): el valor actual se ignora.'
      : null,
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
  (env) => googleWalletWarning(env),
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
