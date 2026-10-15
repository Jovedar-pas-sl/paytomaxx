/**
 * Credenciales que viajan en la URL y no deben acabar en logs ni en Sentry:
 *  - /w/<token>                         enlace del saldo del cliente
 *  - /s/<token>                         QR para pagar con el saldo
 *  - /pay/<token>                       QR del cobro (y /pay/result?op=<pedido>)
 *  - /v1/webhooks/paytef/<secreto>      URL secreta de los avisos de Paytef
 *  - /v1/operators/self-onboarding/<t>  enlace de alta de una chica (72 h)
 *  - /v1/payments/public/<token>, /v1/wallets/public/<token>
 *  - /bot<id>:<token>/…                 llamadas salientes a Telegram
 *  - ?apikey= / ?api-key= / ?token= …   claves de exploradores, firmas de Redsys…
 * Vale para rutas (/w/…) y URLs completas (https://host/…).
 */
const PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^(\/(?:v1\/)?w\/)[^/?#]+/,
  /^(\/(?:v1\/)?s\/)[^/?#]+/,
  /^(\/(?:v1\/)?pay\/)(?!result(?:[/?#]|$))[^/?#]+/,
  /^(\/v1\/webhooks\/paytef\/)[^/?#]+/,
  /^(\/v1\/operators\/self-onboarding\/)[^/?#]+/,
  /^(\/v1\/payments\/public\/)[^/?#]+/,
  /^(\/v1\/wallets\/public\/)[^/?#]+/,
  /^(\/bot)\d+:[^/?#]+/,
];

/** Parámetros de la query que se tapan (nombre sin distinguir mayúsculas). */
const SENSITIVE_QUERY_KEYS = new Set([
  'op',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'key',
  'secret',
  'signature',
  'password',
  'pin',
  'ds_merchantparameters',
  'ds_signature',
]);

const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const MASK = '***';

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const i = value.indexOf(sep);
  return i < 0 ? [value, undefined] : [value.slice(0, i), value.slice(i + 1)];
}

function redactPath(path: string): string {
  const pattern = PATH_PATTERNS.find((re) => re.test(path));
  return pattern ? path.replace(pattern, `$1${MASK}`) : path;
}

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key).toLowerCase();
  } catch {
    return key.toLowerCase();
  }
}

function redactQuery(query: string): string {
  return query
    .split('&')
    .map((part) => {
      const [key, value] = splitOnce(part, '=');
      return value !== undefined && SENSITIVE_QUERY_KEYS.has(decodeKey(key)) ? `${key}=${MASK}` : part;
    })
    .join('&');
}

export function redactSecretsInUrl(url: string): string {
  const origin = ORIGIN.exec(url)?.[0] ?? '';
  const [beforeHash, hash] = splitOnce(url.slice(origin.length), '#');
  const [path, query] = splitOnce(beforeHash, '?');
  const redactedQuery = query === undefined ? '' : `?${redactQuery(query)}`;
  const redactedHash = hash === undefined ? '' : `#${hash}`;
  return `${origin}${redactPath(path)}${redactedQuery}${redactedHash}`;
}

/** Tapa las URLs y rutas que aparezcan dentro de un texto (mensajes, trazas). */
export function redactSecretsInText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactSecretsInUrl(url))
    .replace(/(^|\s)(\/[^\s"'<>]+)/g, (_match, pre: string, path: string) => `${pre}${redactSecretsInUrl(path)}`);
}

/** Compatibilidad: antes solo se tapaba el enlace del saldo. */
export const redactWalletToken = redactSecretsInUrl;
