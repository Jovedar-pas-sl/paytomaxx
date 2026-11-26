/**
 * Idioma de las páginas del cliente (/pay, /s, /w y sus avisos).
 *
 *  - Español SIEMPRE por defecto: nunca el idioma del navegador (decisión del
 *    dueño). El cliente cambia con el selector de arriba a la derecha. Si su
 *    móvil está en inglés, francés o portugués y aún no ha elegido, se le
 *    ofrece cambiar con una franja (suggestedLanguage); la página no cambia sola.
 *  - Lo que elige (?lang=) queda en la cookie `np_lang` (Path=/, 12 horas: esa noche): vale
 *    en todas sus páginas, también en un QR nuevo que no lleva ?lang y a la
 *    vuelta del banco. La página la escribe también desde su JS (y en
 *    localStorage, por si la cookie se pierde): customer-chrome.ts.
 *  - Importes y fechas con el formato de su idioma, siempre en euros y con la
 *    hora de Madrid (eso lo ponen las páginas).
 */
export type PayLanguage = 'es' | 'en' | 'fr' | 'pt';

/** En el orden del selector. */
export const PAY_LANGUAGES: readonly PayLanguage[] = Object.freeze(['es', 'en', 'fr', 'pt'] as const);

export const DEFAULT_LANGUAGE: PayLanguage = 'es';

/** Cada idioma con su nombre en su propio idioma (sin banderas). */
export const LANGUAGE_NAMES: Readonly<Record<PayLanguage, string>> = Object.freeze({
  es: 'Español',
  en: 'English',
  fr: 'Français',
  pt: 'Português',
});

/** Formato de importes y fechas: España, Reino Unido (euros con «€» delante), Francia y Portugal. */
const LOCALES: Readonly<Record<PayLanguage, string>> = Object.freeze({
  es: 'es-ES',
  en: 'en-GB',
  fr: 'fr-FR',
  pt: 'pt-PT',
});

export const LANG_COOKIE = 'np_lang';
export const LANG_COOKIE_MAX_AGE_S = 12 * 3600;

export function isPayLanguage(value: unknown): value is PayLanguage {
  return typeof value === 'string' && (PAY_LANGUAGES as readonly string[]).includes(value);
}

export function languageLocale(lang: PayLanguage): string {
  return LOCALES[lang];
}

/** El idioma guardado en la cookie (null si no hay o no vale). */
export function languageFromCookie(cookieHeader: string | readonly string[] | null | undefined): PayLanguage | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader ?? '');
  for (const part of (header as string).split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === LANG_COOKIE && isPayLanguage(value)) return value;
  }
  return null;
}

/** ?lang= (o el `lang` del formulario) si vale; si no, la cookie; si no, español. */
export function resolveLanguage(query: unknown, cookieHeader?: string | readonly string[] | null): PayLanguage {
  if (isPayLanguage(query)) return query;
  return languageFromCookie(cookieHeader) ?? DEFAULT_LANGUAGE;
}

/**
 * El idioma que se le ofrece (idea 71), sin cambiar la página: el primero de
 * Accept-Language si es inglés, francés o portugués. Null si ya eligió (un
 * ?lang= válido o su cookie, también «seguir en español»), si su móvil está
 * en español o en un idioma que no tenemos.
 */
export function suggestedLanguage(
  acceptLanguage: string | undefined,
  query: unknown,
  cookieHeader: string | readonly string[] | null | undefined,
): PayLanguage | null {
  if (isPayLanguage(query) || languageFromCookie(cookieHeader)) return null;
  const first = /^\s*([a-z]{2,3})(?:[-;,]|\s|$)/i.exec(acceptLanguage ?? '')?.[1]?.toLowerCase();
  return isPayLanguage(first) && first !== DEFAULT_LANGUAGE ? first : null;
}

/** Set-Cookie del idioma elegido. Sin HttpOnly: la página la lee para no perder la elección. */
export function languageCookie(lang: PayLanguage): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE_S}; SameSite=Lax${secure}`;
}

/**
 * El idioma de la página y, si el cliente acaba de elegir otro (?lang= distinto
 * del guardado), la cookie que lo recuerda.
 */
export function customerLanguage(
  query: unknown,
  cookieHeader: string | readonly string[] | null | undefined,
): { lang: PayLanguage; setCookie: string | null } {
  const lang = resolveLanguage(query, cookieHeader);
  const chosen = isPayLanguage(query) && languageFromCookie(cookieHeader) !== query;
  return { lang, setCookie: chosen ? languageCookie(lang) : null };
}
