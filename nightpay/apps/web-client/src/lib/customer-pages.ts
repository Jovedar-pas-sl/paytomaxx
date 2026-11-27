// Las páginas del cliente las sirve el API (con propina, saldo, Face ID y PIN):
//   /pay/:token → página de pago        /w/:token → saldo del cliente
// Esta app solo redirige ahí: los QR antiguos que apuntan aquí siguen valiendo.

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100').replace(/\/+$/, '');

/** Tokens de los QR: UUID (cobro) o base64url (saldo). Lo demás, enlace roto. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

/** Idiomas que entienden las páginas del API; sin ?lang, el que eligió el cliente (su cookie) o español. */
const LANGUAGES: ReadonlySet<string> = new Set(['es', 'en', 'fr', 'pt']);

export type CustomerPage = 'pay' | 'w';

export function isQrToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** URL de la página del cliente en el API, con el ?lang del enlace si es uno válido. */
export function customerPageUrl(page: CustomerPage, token: string, lang: unknown): string {
  const url = `${API_BASE}/${page}/${encodeURIComponent(token)}`;
  return typeof lang === 'string' && LANGUAGES.has(lang) ? `${url}?lang=${lang}` : url;
}

/** «Ver mi saldo» de la portada (idea 73): la página del API que abre el saldo con Face ID o huella. */
export function myBalanceUrl(): string {
  return `${API_BASE}/w/mine`;
}

/** Los textos legales también los sirve el API: /legal/<página>. */
export const LEGAL_LINKS = [
  ['aviso-legal', 'Aviso legal'],
  ['privacidad', 'Privacidad'],
  ['cookies', 'Cookies'],
  ['condiciones', 'Condiciones'],
] as const;

export function legalUrl(doc: (typeof LEGAL_LINKS)[number][0]): string {
  return `${API_BASE}/legal/${doc}`;
}

/** Contacto del titular (el mismo que el Aviso legal del API). */
export const CONTACT_EMAIL = 'info@oxiocard.com';

/** Puertos de desarrollo de las apps del personal (los de docs/DOKPLOY-STEPS.md). */
const STAFF_DEV_PORTS = { admin: 4103, operator: 4104, tpv: 4102 } as const;
export type StaffApp = keyof typeof STAFF_DEV_PORTS;

/**
 * La entrada de cada app del personal, sacada de la URL del API:
 * api.<dominio> → admin.<dominio>; en local, su puerto. Así el dominio
 * nuevo (oxiopay.com) solo cambia NEXT_PUBLIC_API_URL.
 */
export function staffAppUrl(app: StaffApp, apiBase: string = API_BASE): string {
  const api = new URL(apiBase);
  if (api.hostname.startsWith('api.')) return `${api.protocol}//${app}.${api.hostname.slice(4)}`;
  return `${api.protocol}//${api.hostname}:${STAFF_DEV_PORTS[app]}`;
}
