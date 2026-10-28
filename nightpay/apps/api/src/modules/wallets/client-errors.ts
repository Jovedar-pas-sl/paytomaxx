import { CUSTOMER_TEXT } from '../payments/i18n';
import type { ClientErrorTexts } from '../payments/i18n/types';
import type { PayLanguage } from '../payments/pay-i18n';

/**
 * Errores del API en las páginas del cliente (/w, /s, /w/salida y el «Pagado»
 * de /pay). El API responde con un `code` estable; la página enseña el texto
 * de ese `code` en SU idioma (payments/i18n/, un archivo por idioma). Sin
 * `code` conocido: uno genérico en su idioma. Nunca el texto del API: es
 * interno, en castellano y a veces con el vocabulario del personal.
 *
 * `TOPUP_<motivo>`: el 409 WALLET_TOPUP_UNAVAILABLE con su `reason`.
 */
export const CLIENT_ERROR_TEXT: Readonly<Record<PayLanguage, ClientErrorTexts>> = {
  es: CUSTOMER_TEXT.es.errors,
  en: CUSTOMER_TEXT.en.errors,
  fr: CUSTOMER_TEXT.fr.errors,
  pt: CUSTOMER_TEXT.pt.errors,
};

/** Lo que lee el JS de la página: los textos de su idioma. */
export function clientErrorConfig(lang: PayLanguage): Record<string, string> {
  return { ...CLIENT_ERROR_TEXT[lang] };
}

/**
 * npErr(e, E): el texto del error `e` (de pkPost: status, code, reason,
 * message) con los textos E de clientErrorConfig. Sin barras invertidas: va
 * dentro de plantillas de TypeScript.
 */
export const CLIENT_ERROR_JS = `
function npErr(e,E){if(!e)return E.generic;
 var k=e.code==='WALLET_TOPUP_UNAVAILABLE'?'TOPUP_'+(E['TOPUP_'+e.reason]?e.reason:'venue'):e.code;
 if(k&&Object.prototype.hasOwnProperty.call(E,k)&&typeof E[k]==='string')return E[k];
 if(e.status===429)return E.RATE_LIMITED;
 if(!e.status)return e.name==='TypeError'?E.network:E.generic;
 return E.generic;}
`;
