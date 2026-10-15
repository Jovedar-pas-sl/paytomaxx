// Las páginas del cliente las sirve el API (con propina, saldo, Face ID y PIN):
//   /pay/:token → página de pago        /w/:token → saldo del cliente
// Esta app solo redirige ahí: los QR antiguos que apuntan aquí siguen valiendo.

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100').replace(/\/+$/, '');

/** Tokens de los QR: UUID (cobro) o base64url (saldo). Lo demás, enlace roto. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

/** Idiomas que entienden las páginas del API; sin ?lang eligen por el móvil. */
const LANGUAGES: ReadonlySet<string> = new Set(['es', 'en']);

export type CustomerPage = 'pay' | 'w';

export function isQrToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** URL de la página del cliente en el API, con el ?lang del enlace si es uno válido. */
export function customerPageUrl(page: CustomerPage, token: string, lang: unknown): string {
  const url = `${API_BASE}/${page}/${encodeURIComponent(token)}`;
  return typeof lang === 'string' && LANGUAGES.has(lang) ? `${url}?lang=${lang}` : url;
}
