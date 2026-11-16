import { CLUB_BASE_CSS, escapeHtml } from '../payments/club-ui';
import { CHROME_CSS, langScript, topBar } from '../payments/customer-chrome';
import { languageLocale, type PayLanguage } from '../payments/customer-lang';
import { LEGAL_DOC_IDS, legalDocs, legalTextLanguage, type LegalBlock, type LegalDocId } from './legal-docs';
import { legalHref, legalLabels } from './legal-links';
import { LEGAL_OWNER, LEGAL_UPDATED, type LegalOwner } from './legal-owner';

/**
 * Una página legal (/legal/<id>): la barra de siempre (logo e idioma), las
 * cuatro páginas como pestañas, el título, la fecha y el texto.
 */

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const SAFE_HREF = /^(https:\/\/|mailto:|\/legal\/)/;

/** Texto escapado con sus [enlaces](…); a los de /legal/… se les añade el idioma. */
function inline(text: string, lang: PayLanguage): string {
  return escapeHtml(text).replace(LINK_RE, (_m, label: string, href: string) => {
    if (!SAFE_HREF.test(href)) return label;
    if (href.startsWith('/legal/')) {
      const [path, hash] = href.split('#');
      return `<a href="${path}?lang=${lang}${hash ? `#${hash}` : ''}">${label}</a>`;
    }
    const external = href.startsWith('https://') ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${href}"${external}>${label}</a>`;
  });
}

function renderBlock(block: LegalBlock, lang: PayLanguage, title: string): string {
  if ('h' in block) return `<h2${block.id ? ` id="${escapeHtml(block.id)}"` : ''}>${inline(block.h, lang)}</h2>`;
  if ('p' in block) return `<p>${inline(block.p, lang)}</p>`;
  if ('ul' in block) return `<ul>${block.ul.map((li) => `<li>${inline(li, lang)}</li>`).join('')}</ul>`;
  const head = block.table.head.map((cell) => `<th scope="col">${inline(cell, lang)}</th>`).join('');
  const rows = block.table.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) =>
            i === 0
              ? `<th scope="row"><code>${inline(cell, lang)}</code></th>`
              : `<td data-label="${escapeHtml(block.table.head[i] ?? '')}">${inline(cell, lang)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  // Con scroll propio en pantallas estrechas: enfocable para moverla con el teclado.
  return `<div class="tbl" role="region" tabindex="0" aria-label="${escapeHtml(title)}"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function updatedLine(lang: PayLanguage): string {
  const textLang = legalTextLanguage(lang);
  const date = new Intl.DateTimeFormat(languageLocale(textLang), { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${LEGAL_UPDATED}T12:00:00Z`),
  );
  return textLang === 'es' ? `Actualizado el ${date}` : `Updated ${date}`;
}

const LEGAL_PAGE_CSS = `
.legal{width:100%;max-width:40rem;margin:0 auto;padding:.5rem 1rem calc(2.5rem + env(safe-area-inset-bottom));line-height:1.6;color:var(--mute)}
.legal .tabs{display:flex;flex-wrap:wrap;gap:.375rem .5rem;margin:0 0 1.5rem}
.legal .tabs a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .875rem;border:1px solid var(--line);border-radius:999px;color:var(--fg);font-size:.875rem;font-weight:500;text-decoration:none}
.legal .tabs a[aria-current=page]{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.legal h1{margin:0;color:var(--fg);font-size:clamp(1.75rem,7vw,2.25rem);font-weight:600;letter-spacing:-.02em;line-height:1.15}
.legal .upd{margin:.5rem 0 0;font-size:.8125rem;color:var(--dim)}
.legal .note{margin:1rem 0 0;padding:.75rem 1rem;border-radius:var(--r-field);background:var(--surface-2);font-size:.875rem}
.legal h2{margin:2rem 0 .5rem;color:var(--fg);font-size:1.125rem;font-weight:600;line-height:1.3;scroll-margin-top:1rem}
.legal p{margin:.5rem 0}
.legal ul{margin:.5rem 0;padding-left:1.25rem}
.legal li{margin:.375rem 0}
.legal a{color:var(--fg);text-decoration:underline;text-underline-offset:.15em;overflow-wrap:anywhere}
.legal a:focus-visible,.legal .tbl:focus-visible{outline:3px solid var(--fg);outline-offset:2px;border-radius:4px}
.legal .tbl{margin:1rem 0;overflow-x:auto;border:1px solid var(--line);border-radius:var(--r-field)}
.legal table{width:100%;min-width:30rem;border-collapse:collapse;font-size:.875rem}
.legal th,.legal td{padding:.625rem .75rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
.legal thead th{background:var(--surface);color:var(--fg);font-weight:600}
.legal tbody tr:last-child>*{border-bottom:0}
.legal code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8125rem;color:var(--fg)}
@media (max-width:34rem){
.legal table{min-width:0}
.legal thead{display:none}
.legal tr{display:block;padding:.75rem;border-bottom:1px solid var(--line)}
.legal tbody tr:last-child{border-bottom:0}
.legal th,.legal td{display:block;padding:0;border:0}
.legal td{margin-top:.375rem}
.legal td::before{content:attr(data-label);display:block;font-size:.75rem;color:var(--dim)}
}
@media print{.legal .tabs{display:none}}
`;

export function renderLegalPage(doc: LegalDocId, lang: PayLanguage, owner: LegalOwner = LEGAL_OWNER): string {
  const page = legalDocs(lang, owner)[doc];
  const labels = legalLabels(lang);
  const tabs = LEGAL_DOC_IDS.map(
    (id) =>
      `<a href="${escapeHtml(legalHref(id, lang))}"${id === doc ? ' aria-current="page"' : ''}>${escapeHtml(labels.links[id])}</a>`,
  ).join('');
  const note = labels.note ? `<p class="note" lang="${lang}">${escapeHtml(labels.note)}</p>` : '';
  const body = page.blocks.map((block) => renderBlock(block, lang, page.title)).join('\n');
  return `<!DOCTYPE html>
<html lang="${legalTextLanguage(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d0e"><title>${escapeHtml(page.title)} · OxioPay</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${LEGAL_PAGE_CSS}</style>
</head><body>
${topBar(lang, (l) => legalHref(doc, l))}
<main class="legal">
<nav class="tabs" aria-label="${escapeHtml(labels.nav)}">${tabs}</nav>
<h1>${escapeHtml(page.title)}</h1>
<p class="upd">${escapeHtml(updatedLine(lang))}</p>${note}
${body}
</main>
${langScript()}
</body></html>`;
}
