import type { PayLanguage } from '../customer-lang';
import { EN } from './en';
import { ES } from './es';
import { FR } from './fr';
import { PT } from './pt';
import type { CustomerTexts } from './types';

export type * from './types';
export { CLIENT_ERROR_KEYS } from './types';

/** Los textos del cliente en cada idioma (es.ts es el original). */
export const CUSTOMER_TEXT: Readonly<Record<PayLanguage, CustomerTexts>> = Object.freeze({ es: ES, en: EN, fr: FR, pt: PT });
