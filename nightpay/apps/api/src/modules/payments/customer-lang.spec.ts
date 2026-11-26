import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_NAMES,
  LANG_COOKIE,
  PAY_LANGUAGES,
  customerLanguage,
  languageCookie,
  languageFromCookie,
  languageLocale,
  resolveLanguage,
  suggestedLanguage,
} from './customer-lang';

/**
 * Idioma de las páginas del cliente: español SIEMPRE por defecto (nunca el
 * del navegador); el que elija en el selector (?lang=) queda en su cookie y
 * vale en todas las páginas del cliente.
 */
describe('idioma de las páginas del cliente', () => {
  it('los cuatro idiomas, con su nombre en su propio idioma', () => {
    expect(PAY_LANGUAGES).toEqual(['es', 'en', 'fr', 'pt']);
    expect(LANGUAGE_NAMES).toEqual({ es: 'Español', en: 'English', fr: 'Français', pt: 'Português' });
  });

  it('sin ?lang ni cookie: español, aunque el móvil esté en inglés o francés', () => {
    expect(resolveLanguage(undefined, undefined)).toBe('es');
    expect(resolveLanguage(undefined, '')).toBe('es');
    expect(resolveLanguage(undefined, 'otra=1; foo=bar')).toBe('es');
  });

  it('?lang manda; si no vale, la cookie; si tampoco, español', () => {
    expect(resolveLanguage('fr', `${LANG_COOKIE}=pt`)).toBe('fr');
    expect(resolveLanguage('pt', undefined)).toBe('pt');
    expect(resolveLanguage('de', `${LANG_COOKIE}=en`)).toBe('en');
    expect(resolveLanguage(['en'], undefined)).toBe('es');
    expect(resolveLanguage(undefined, `a=1; ${LANG_COOKIE}=fr; b=2`)).toBe('fr');
    expect(resolveLanguage(undefined, `${LANG_COOKIE}=xx`)).toBe('es');
    expect(resolveLanguage(undefined, [`${LANG_COOKIE}=pt`])).toBe('pt');
  });

  it('la cookie: solo un valor válido', () => {
    expect(languageFromCookie(`${LANG_COOKIE}=en`)).toBe('en');
    expect(languageFromCookie(`x${LANG_COOKIE}=en`)).toBeNull();
    expect(languageFromCookie(`${LANG_COOKIE}=EN`)).toBeNull();
    expect(languageFromCookie(null)).toBeNull();
  });

  it('se recuerda: Set-Cookie solo cuando ?lang cambia lo guardado', () => {
    expect(customerLanguage('fr', undefined)).toEqual({ lang: 'fr', setCookie: languageCookie('fr') });
    expect(customerLanguage('fr', `${LANG_COOKIE}=fr`)).toEqual({ lang: 'fr', setCookie: null });
    expect(customerLanguage(undefined, `${LANG_COOKIE}=pt`)).toEqual({ lang: 'pt', setCookie: null });
    expect(customerLanguage(undefined, undefined)).toEqual({ lang: 'es', setCookie: null });
    expect(customerLanguage('zz', undefined)).toEqual({ lang: 'es', setCookie: null });
  });

  it('la cookie vale para /pay, /s y /w (Path=/), 12 horas, Lax y legible por la página', () => {
    const c = languageCookie('pt');
    expect(c).toMatch(new RegExp(`^${LANG_COOKIE}=pt; Path=/; Max-Age=43200; SameSite=Lax`));
    expect(c).not.toContain('HttpOnly');
  });

  it('idea 71: el idioma del móvil no cambia la página, solo se ofrece: el primero de Accept-Language si es inglés, francés o portugués', () => {
    expect(suggestedLanguage('en-GB,en;q=0.9,es;q=0.8', undefined, undefined)).toBe('en');
    expect(suggestedLanguage('fr-FR,fr;q=0.9,en;q=0.8', undefined, undefined)).toBe('fr');
    expect(suggestedLanguage('pt-BR', undefined, undefined)).toBe('pt');
    expect(suggestedLanguage('EN-us', undefined, '')).toBe('en');
    expect(suggestedLanguage('en;q=0.8', undefined, 'otra=1')).toBe('en');
    // Solo el primero: un móvil en español que también entiende inglés se queda como está.
    expect(suggestedLanguage('es-ES,en', undefined, undefined)).toBeNull();
    expect(suggestedLanguage('es', undefined, undefined)).toBeNull();
    // Un idioma que no tenemos, nada raro y sin cabecera: nada.
    expect(suggestedLanguage('de', undefined, undefined)).toBeNull();
    expect(suggestedLanguage('de-DE,en;q=0.9', undefined, undefined)).toBeNull();
    expect(suggestedLanguage('frr', undefined, undefined)).toBeNull();
    expect(suggestedLanguage('*', undefined, undefined)).toBeNull();
    expect(suggestedLanguage('', undefined, undefined)).toBeNull();
    expect(suggestedLanguage(undefined, undefined, undefined)).toBeNull();
    // Ya eligió (?lang= o su cookie, también «seguir en español»): no se le vuelve a ofrecer.
    expect(suggestedLanguage('en-GB', 'es', undefined)).toBeNull();
    expect(suggestedLanguage('en-GB', 'en', undefined)).toBeNull();
    expect(suggestedLanguage('en-GB', undefined, `${LANG_COOKIE}=es`)).toBeNull();
    expect(suggestedLanguage('en-GB', undefined, `a=1; ${LANG_COOKIE}=fr`)).toBeNull();
    // Un ?lang= que no vale no es una elección.
    expect(suggestedLanguage('en-GB', 'zz', undefined)).toBe('en');
    // Y la página, siempre en español mientras no elija.
    expect(resolveLanguage(undefined, undefined)).toBe('es');
  });

  it('formato del idioma: España, Reino Unido, Francia y Portugal', () => {
    expect(PAY_LANGUAGES.map(languageLocale)).toEqual(['es-ES', 'en-GB', 'fr-FR', 'pt-PT']);
  });
});
