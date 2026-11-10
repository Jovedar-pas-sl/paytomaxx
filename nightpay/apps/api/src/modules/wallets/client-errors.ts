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
/**
 * Los de la propina que elige el cliente en /s (B1) y de «Ver mi saldo»
 * (my-balance.ts). Aparte de payments/i18n/ para no pisar sus textos.
 */
const MORE_ERRORS: Readonly<Record<PayLanguage, Record<'TIP_NOT_VALID' | 'WALLET_NOT_FOUND', string>>> = {
  es: {
    TIP_NOT_VALID: 'Esa propina no vale: elige otra o «Sin propina».',
    WALLET_NOT_FOUND: 'No encontramos tu saldo. Pregunta en recepción.',
  },
  en: {
    TIP_NOT_VALID: 'That tip isn’t valid: choose another one or “No tip”.',
    WALLET_NOT_FOUND: 'We couldn’t find your balance. Ask at reception.',
  },
  fr: {
    TIP_NOT_VALID: 'Ce pourboire n’est pas valable : choisissez-en un autre ou « Sans pourboire ».',
    WALLET_NOT_FOUND: 'Nous ne trouvons pas votre solde. Demandez à l’accueil.',
  },
  pt: {
    TIP_NOT_VALID: 'Essa gorjeta não é válida: escolha outra ou «Sem gorjeta».',
    WALLET_NOT_FOUND: 'Não encontramos o seu saldo. Pergunte na receção.',
  },
};

export const CLIENT_ERROR_TEXT: Readonly<Record<PayLanguage, ClientErrorTexts>> = {
  es: { ...CUSTOMER_TEXT.es.errors, ...MORE_ERRORS.es },
  en: { ...CUSTOMER_TEXT.en.errors, ...MORE_ERRORS.en },
  fr: { ...CUSTOMER_TEXT.fr.errors, ...MORE_ERRORS.fr },
  pt: { ...CUSTOMER_TEXT.pt.errors, ...MORE_ERRORS.pt },
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
