import { WALLET_CARD_PARAM, WALLET_PASS_PARAM } from '@nightpay/contracts';
import { UNPREFIXED_ROUTES, type UnprefixedRoute } from '../http/unprefixed-routes';

/**
 * Credenciales que viajan en la URL y no deben acabar en logs ni en Sentry:
 *  - las páginas del cliente fuera de /v1 con :token (UNPREFIXED_ROUTES):
 *    /pay/<token>, /s/<token>, /w/<token>, /w/card/<token> (ficha NFC),
 *    /w/salida/<token> (salida de recepción), /c/<token> (QR del pase de
 *    Google Wallet)… y /pay/result?op=<pedido>
 *  - /v1/webhooks/paytef/<secreto>      URL secreta de los avisos de Paytef
 *  - /v1/webhooks/btcpay/<token>        token del aviso de BTCPay de cada local
 *  - /v1/operators/self-onboarding/<t>  enlace de alta de una chica (72 h)
 *  - /v1/payments/public/<token>, /v1/wallets/public/<token>
 *  - /bot<id>:<token>/…                 llamadas salientes a Telegram
 *  - ?apikey= / ?api-key= / ?token= …   claves de exploradores, firmas de Redsys…
 * Vale para rutas (/w/…) y URLs completas (https://host/…).
 */

const TOKEN_SEGMENT = ':token';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Un patrón por cada prefijo con :token de las rutas públicas (`w/card/:token`
 * → /w/card/<token>), los más largos primero (/w/card antes que /w). En la
 * posición del token no se tapan los segmentos fijos de otras rutas del mismo
 * prefijo (/w/card, /w/assets, /pay/result…). Una ruta nueva con :token en
 * unprefixed-routes.ts queda tapada sin tocar esto.
 */
export function tokenPathPatterns(routes: ReadonlyArray<UnprefixedRoute>): RegExp[] {
  const segmentsOf = routes.map((r) => r.path.split('/'));
  const prefixes = new Map<string, string[]>();
  for (const segs of segmentsOf) {
    const at = segs.indexOf(TOKEN_SEGMENT);
    if (at > 0) prefixes.set(segs.slice(0, at).join('/'), segs.slice(0, at));
  }
  return [...prefixes.values()]
    .sort((a, b) => b.length - a.length)
    .map((prefix) => {
      const fixed = new Set(
        segmentsOf
          .filter((segs) => segs.length > prefix.length && prefix.every((p, i) => segs[i] === p))
          .map((segs) => segs[prefix.length]!)
          .filter((seg) => !seg.startsWith(':')),
      );
      const notFixed = fixed.size > 0 ? `(?!(?:${[...fixed].map(escapeRegExp).join('|')})(?:[/?#]|$))` : '';
      return new RegExp(`^(/(?:v1/)?${prefix.map(escapeRegExp).join('/')}/)${notFixed}[^/?#]+`);
    });
}

const PATH_PATTERNS: ReadonlyArray<RegExp> = [
  ...tokenPathPatterns(UNPREFIXED_ROUTES),
  /^(\/v1\/webhooks\/paytef\/)[^/?#]+/,
  // El token de la ruta del aviso de BTCPay de cada local.
  /^(\/v1\/webhooks\/btcpay\/)[^/?#]+/,
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
  // Datos personales: el teléfono del cliente (por si alguien lo pone en una URL).
  'phone',
  'telefono',
  'ds_merchantparameters',
  'ds_signature',
  // La app del personal abierta desde el QR del pase de Google Wallet (/c/<token>).
  WALLET_PASS_PARAM,
  // El enlace grabado en la ficha NFC (https://…/?ficha=<código>): el código es la ficha.
  WALLET_CARD_PARAM,
]);

const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const MASK = '***';

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const i = value.indexOf(sep);
  return i < 0 ? [value, undefined] : [value.slice(0, i), value.slice(i + 1)];
}

function redactPath(path: string): string {
  const pattern = PATH_PATTERNS.find((re) => re.test(path));
  const redacted = pattern ? path.replace(pattern, `$1${MASK}`) : path;
  // Cada segmento con una clave de socio o un código del móvil, también codificados, entero fuera.
  return redacted
    .split('/')
    .map((segment) => (hasPartnerSecret(segment) ? MASK : segment))
    .join('/');
}

/**
 * Los escapes ASCII válidos (%5F → _) decodificados y los demás tal cual: un
 * escape roto (%ZZ, una secuencia UTF-8 a medias) en la misma pieza no impide
 * ver lo que lleva al lado (decodeURIComponent fallaría entero).
 */
export function decodeAsciiEscapes(text: string): string {
  return text.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
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
      if (value !== undefined && (SENSITIVE_QUERY_KEYS.has(decodeKey(key)) || hasPartnerSecret(value))) return `${key}=${MASK}`;
      return redactPartnerSecrets(part);
    })
    .join('&');
}

/** El valor lleva una clave de socio o un código del móvil (tal cual o codificado, aunque haya otros escapes rotos). */
function hasPartnerSecret(value: string): boolean {
  return [value, decodeKey(value), decodeAsciiEscapes(value)].some((v) => redactPartnerSecrets(v) !== v);
}

export function redactSecretsInUrl(url: string): string {
  const origin = ORIGIN.exec(url)?.[0] ?? '';
  const [beforeHash, hash] = splitOnce(url.slice(origin.length), '#');
  const [path, query] = splitOnce(beforeHash, '?');
  const redactedQuery = query === undefined ? '' : `?${redactQuery(query)}`;
  const redactedHash = hash === undefined ? '' : `#${hash}`;
  return `${origin}${redactPartnerSecrets(redactPath(path))}${redactedQuery}${redactedHash}`;
}

/** Una clave de socio (oxp_live_…, oxp_test_…) o un código del móvil (OXC1:…), también a medias o codificados. */
const PARTNER_SECRET = /oxp(?:_|%5F)(?:live|test)(?:_|%5F)[0-9A-Za-z]*|OXC1(?::|%3A)[0-9A-Za-z]*/gi;

/** Tapa las claves de socio y los códigos del móvil de cualquier texto. */
export function redactPartnerSecrets(text: string): string {
  return text.replace(PARTNER_SECRET, MASK);
}

/** Tapa las URLs y rutas que aparezcan dentro de un texto (mensajes, trazas). */
export function redactSecretsInText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactSecretsInUrl(url))
    .replace(/(^|\s)(\/[^\s"'<>]+)/g, (_match, pre: string, path: string) => `${pre}${redactSecretsInUrl(path)}`);
}

/** Un texto que va a un log (mensaje o traza): URLs y rutas con token, y las claves de socio en cualquier sitio. */
export function redactLogText(text: string): string {
  return redactPartnerSecrets(redactSecretsInText(text));
}

/** Compatibilidad: antes solo se tapaba el enlace del saldo. */
export const redactWalletToken = redactSecretsInUrl;
