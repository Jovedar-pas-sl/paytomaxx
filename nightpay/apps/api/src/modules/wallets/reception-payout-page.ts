import { CLUB_BASE_CSS, escapeHtml } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../payments/customer-chrome';
import { legalFooter } from '../legal/legal-links';
import { CUSTOMER_TEXT } from '../payments/i18n';
import type { PayLanguage } from '../payments/pay-i18n';
import { myBalanceBlock } from './my-balance';

/**
 * Lo que ve el cliente si abre un QR de la salida de recepción de antes
 * (/w/salida/:token): la salida ya no devuelve dinero. La regla («El saldo no
 * se devuelve: se queda para la próxima visita») en su idioma y «Ver mi
 * saldo» con su Face ID. Ni importes, ni el código, ni el id del saldo.
 */
export function renderPayoutConfirmPage(base: string, lang: PayLanguage): string {
  const t = CUSTOMER_TEXT[lang].wallet;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#091518"><title>${escapeHtml(t.title)}</title><style>${CLUB_BASE_CSS}${CHROME_CSS}
main{max-width:28rem;min-height:calc(100svh - 3.5rem);margin:auto;padding:1rem 1rem 2rem;display:flex;flex-direction:column;justify-content:center;gap:1.5rem}.box{padding:1.5rem 1.25rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);display:grid;gap:1rem}.box h1{font-size:1.375rem}.rule{margin:0;color:var(--fg)}</style></head><body>${topBar(lang, (l) => `${base}?lang=${l}`)}<main><section class="box"><h1>${escapeHtml(t.title)}</h1><p class="rule" role="status">${escapeHtml(t.keepRule)}</p>${myBalanceBlock(lang, { withPasskeyJs: true })}</section></main>${legalFooter(lang)}<script>${LANG_JS}</script></body></html>`;
}
