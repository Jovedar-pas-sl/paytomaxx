import { escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/customer-lang';
import { LEGAL_DOC_IDS, type LegalDocId } from './legal-docs';

/**
 * Los enlaces a los textos legales que llevan las páginas del cliente: el pie
 * (las cuatro páginas) y, junto al botón de pagar, «Al pagar aceptas…».
 * Los nombres van en los cuatro idiomas; los textos, en castellano e inglés.
 */

interface LegalLabels {
  readonly nav: string;
  readonly links: Readonly<Record<LegalDocId, string>>;
  /** «Al pagar aceptas las {Condiciones} y la {Política de privacidad}.» */
  readonly consent: readonly [string, string, string, string, string];
  /** Aviso de que el texto no va en el idioma elegido (o que vale el castellano). */
  readonly note: string | null;
}

const LABELS: Readonly<Record<PayLanguage, LegalLabels>> = Object.freeze({
  es: {
    nav: 'Textos legales',
    links: { 'aviso-legal': 'Aviso legal', privacidad: 'Privacidad', cookies: 'Cookies', condiciones: 'Condiciones' },
    consent: ['Al pagar aceptas las ', 'Condiciones', ' y la ', 'Política de privacidad', '.'],
    note: null,
  },
  en: {
    nav: 'Legal',
    links: { 'aviso-legal': 'Legal notice', privacidad: 'Privacy', cookies: 'Cookies', condiciones: 'Terms' },
    consent: ['By paying you accept the ', 'Terms', ' and the ', 'Privacy policy', '.'],
    note: 'Translation for information only: the Spanish version prevails.',
  },
  fr: {
    nav: 'Informations légales',
    links: { 'aviso-legal': 'Mentions légales', privacidad: 'Confidentialité', cookies: 'Cookies', condiciones: 'Conditions' },
    consent: ['En payant, vous acceptez les ', 'Conditions', ' et la ', 'Politique de confidentialité', '.'],
    note: 'Ces textes sont disponibles en espagnol et en anglais. La version espagnole fait foi.',
  },
  pt: {
    nav: 'Informações legais',
    links: { 'aviso-legal': 'Aviso legal', privacidad: 'Privacidade', cookies: 'Cookies', condiciones: 'Condições' },
    consent: ['Ao pagar, aceita as ', 'Condições', ' e a ', 'Política de privacidade', '.'],
    note: 'Estes textos estão disponíveis em espanhol e em inglês. Prevalece a versão espanhola.',
  },
});

export function legalLabels(lang: PayLanguage): LegalLabels {
  return LABELS[lang];
}

/** /legal/<página>?lang=xx (con `base`, absoluta: las apps que no van en el dominio del API). */
export function legalHref(doc: LegalDocId, lang: PayLanguage, base = ''): string {
  return `${base}/legal/${doc}?lang=${lang}`;
}

function link(doc: LegalDocId, lang: PayLanguage, label: string): string {
  return `<a href="${escapeHtml(legalHref(doc, lang))}">${escapeHtml(label)}</a>`;
}

/** El pie de las páginas del cliente: Aviso legal · Privacidad · Cookies · Condiciones. */
export function legalFooter(lang: PayLanguage): string {
  const l = LABELS[lang];
  const links = LEGAL_DOC_IDS.map((doc) => link(doc, lang, l.links[doc])).join('');
  return `<footer class="legal-foot"><nav aria-label="${escapeHtml(l.nav)}">${links}</nav></footer>`;
}

/** «Al pagar aceptas las Condiciones y la Política de privacidad.», junto al botón de pagar. */
export function legalConsent(lang: PayLanguage): string {
  const [a, terms, b, privacy, c] = LABELS[lang].consent;
  return `<p class="legal-ok">${escapeHtml(a)}${link('condiciones', lang, terms)}${escapeHtml(b)}${link('privacidad', lang, privacy)}${escapeHtml(c)}</p>`;
}

/** CSS del pie y de «Al pagar aceptas…» (va en CHROME_CSS: lo llevan todas las páginas del cliente). */
export const LEGAL_LINKS_CSS = `
.legal-foot{width:100%;max-width:26rem;margin:0 auto;padding:.5rem 1rem calc(1rem + env(safe-area-inset-bottom))}
.legal-foot nav{display:flex;flex-wrap:wrap;justify-content:center;column-gap:1rem}
.legal-foot a{display:inline-flex;align-items:center;min-height:2.75rem;font-size:.8125rem}
.legal-foot a,.legal-ok a{color:var(--dim);text-decoration:underline;text-underline-offset:.15em}
.legal-foot a:hover,.legal-ok a:hover{color:var(--fg)}
.legal-foot a:focus-visible,.legal-ok a:focus-visible{outline:3px solid var(--fg);outline-offset:2px;border-radius:4px}
.legal-ok{margin:.375rem 0 0;font-size:.8125rem;line-height:1.5;color:var(--dim);text-align:center}
@media print{.legal-foot{display:none!important}}
`;
