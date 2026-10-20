/**
 * El QR del pase de Google Wallet del cliente: https://api.../c/<token>, un
 * token SOLO para cobrar (el cliente pone su PIN). Nunca abre el saldo: el
 * enlace del saldo (/w/<token>) va aparte y no lo acepta el personal.
 *
 * Con la cámara normal del móvil, /c/<token> lleva a la app del personal con
 * ?pase=<token> (como la ficha NFC en iPhone con ?ficha=); dentro de la app,
 * el texto del QR se lee con passChargeTokenFromText.
 */

/** El parámetro con el que se abre la app del personal desde el QR del pase. */
export const WALLET_PASS_PARAM = 'pase';

/** El segmento de la ruta del QR del pase (/c/<token>). */
export const WALLET_PASS_SEGMENT = 'c';

/** id del saldo (16 bytes) + firma (16 bytes), en base64url. */
const PASS_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** ¿Tiene la forma de un token de cobro del pase? (la firma la comprueba el API). */
export function isPassChargeToken(value: string): boolean {
  return PASS_TOKEN.test(value);
}

/**
 * El token de cobro de un texto leído o pegado: …/c/<token> o …/?pase=<token>
 * (null si no es eso; tampoco vale el enlace del saldo /w/…). Solo mira la
 * forma: el texto nunca se abre.
 */
export function passChargeTokenFromText(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const [, segment, token, ...rest] = url.pathname.replace(/\/+$/, '').split('/');
  if (segment === WALLET_PASS_SEGMENT && token && rest.length === 0 && isPassChargeToken(token)) return token;
  const param = url.searchParams.get(WALLET_PASS_PARAM) ?? '';
  return isPassChargeToken(param) ? param : null;
}
