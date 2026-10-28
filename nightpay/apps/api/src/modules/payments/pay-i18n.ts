import { HttpException } from '@nestjs/common';
import { CUSTOMER_TEXT } from './i18n';
import type { PayLanguage } from './customer-lang';
import type { PayErrorKey, PayText } from './i18n/types';

/**
 * Textos de las páginas del cliente (/pay/...) en los cuatro idiomas: están
 * en i18n/ (un archivo por idioma). Discretos: sin nombres internos ni tipo
 * de servicio. El idioma: customer-lang.ts (español por defecto, nunca el del
 * navegador; el que elige el cliente queda en su cookie).
 */
export type { PayLanguage } from './customer-lang';
export { resolveLanguage } from './customer-lang';
export type { PayErrorKey, PayNotice, PayText, UnlockText } from './i18n/types';

export const PAY_TEXT = {
  es: CUSTOMER_TEXT.es.pay,
  en: CUSTOMER_TEXT.en.pay,
  fr: CUSTOMER_TEXT.fr.pay,
  pt: CUSTOMER_TEXT.pt.pay,
} as const satisfies Record<PayLanguage, PayText>;

/**
 * Página de cada error de la pasarela por su `code` (payments.service.ts): el
 * código va con el estado en que queda el cobro, así la página nunca ofrece
 * reintentar un cobro muerto ni da por muerto uno que se puede pagar.
 */
const PAY_ERROR_CODES: Readonly<Record<string, PayErrorKey>> = {
  GATEWAY_RETRY: 'gateway',
  GATEWAY_FAILED: 'gatewayFailed',
  GATEWAY_FAILED_AFTER_ATTEMPT: 'gatewayFailedAfterAttempt',
};

/** La página del error: por su `code` si es de la pasarela; si no, por el texto, como antes (payErrorKey). */
export function payErrorKeyOf(err: unknown): PayErrorKey {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    const key = typeof code === 'string' ? PAY_ERROR_CODES[code] : undefined;
    if (key) return key;
  }
  return payErrorKey((err as Error | null)?.message || 'Error');
}

/**
 * Traduce errores técnicos a una frase para el cliente. Nunca se muestran
 * detalles internos (ni códigos del banco).
 */
export function payErrorKey(message: string): PayErrorKey {
  const m = message.toLowerCase();
  if (m.includes('expired') || m.includes('expirado') || m.includes('caduca')) return 'expired';
  if (m.includes('not found') || m.includes('no encontrado')) return 'notFound';
  if (m.includes('already') || m.includes('in progress')) return 'inProgress';
  if (m.includes('gateway') || m.includes('pasarela') || m.includes('redsys') || m.includes('sis')) {
    return 'gateway';
  }
  return 'generic';
}
