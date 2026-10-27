import { CUSTOMER_TEXT } from '../payments/i18n';
import type { PayLanguage } from '../payments/pay-i18n';
import type { WalletText } from '../payments/i18n/types';

/**
 * Textos de la página del saldo del cliente (/w/:token), en los cuatro
 * idiomas (payments/i18n/, un archivo por idioma). Los de activar el
 * desbloqueo del móvil (Face ID, huella…) son los de pay-i18n (`unlock`).
 * `{amount}` y `{cards}` los rellena el JS.
 */
export type { WalletText } from '../payments/i18n/types';

export const WALLET_TEXT: Readonly<Record<PayLanguage, WalletText>> = {
  es: CUSTOMER_TEXT.es.wallet,
  en: CUSTOMER_TEXT.en.wallet,
  fr: CUSTOMER_TEXT.fr.wallet,
  pt: CUSTOMER_TEXT.pt.wallet,
};
