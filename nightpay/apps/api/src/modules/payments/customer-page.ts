import { CLUB_BASE_CSS, escapeHtml } from './club-ui';
import { CHROME_CSS, defaultLangHref, langScript, topBar, type LangHref } from './customer-chrome';
import type { PayText } from './pay-i18n';

/**
 * El esqueleto de las páginas de /pay (public-pay.pages.ts y «Comprobando
 * el pago», pay-checking-page.ts): la barra de arriba (logo e idioma) y el
 * cuerpo, con el CSS de la marca (club-ui) y el del selector de idioma.
 */

const PAGE_CSS = `
.c{width:100%;max-width:26rem;margin:0 auto;min-height:calc(100vh - 3.5rem);min-height:calc(100svh - 3.5rem);padding:1rem 1rem 2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.8rem;text-align:center}
.amount{font-size:clamp(2.5rem,12vw,3rem);font-weight:600;letter-spacing:-.02em;line-height:1.05;color:var(--fg);font-variant-numeric:proportional-nums}
.small{font-size:.875rem}
.foot{margin-top:1.25rem}
`;

/**
 * Esqueleto común: la barra de arriba (logo e idioma) y el cuerpo. `full`:
 * el cuerpo va a todo el ancho (el «Pagado», con la barra encima); `bare`:
 * el cuerpo pone su propio <main> (la página de pago); por defecto, columna
 * centrada con «Pago seguro» al pie.
 */
export function customerPage(
  t: PayText,
  title: string,
  body: string,
  opts: { head?: string; layout?: 'center' | 'full' | 'bare'; langHref?: LangHref } = {},
): string {
  const layout = opts.layout ?? 'center';
  const hrefFor = opts.langHref ?? defaultLangHref;
  const lang = t.htmlLang;
  const main =
    layout === 'full'
      ? `${topBar(lang, hrefFor, { over: true })}\n<main>${body}</main>`
      : layout === 'bare'
        ? `${topBar(lang, hrefFor)}\n${body}`
        : `${topBar(lang, hrefFor)}\n<main class="c">${body}\n<p class="foot">${escapeHtml(t.secure)}</p></main>`;
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0d0e"><title>${escapeHtml(title)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${PAGE_CSS}</style>${opts.head ?? ''}
</head><body>
${main}
${langScript()}
</body></html>`;
}
