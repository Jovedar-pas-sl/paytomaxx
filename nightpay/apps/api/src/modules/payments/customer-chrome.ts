import { brandWordmark, escapeHtml } from './club-ui';
import { LANGUAGE_NAMES, LANG_COOKIE, LANG_COOKIE_MAX_AGE_S, PAY_LANGUAGES, type PayLanguage } from './customer-lang';
import { CUSTOMER_TEXT } from './i18n';

/**
 * Lo común de arriba de las páginas del cliente: el logo y, arriba a la
 * derecha, el selector de idioma (discreto: «ES» con un globo; cada idioma
 * con su nombre en su idioma, sin banderas).
 *
 *  - Sin JS funciona: es un <details> con enlaces ?lang=…; el API guarda la
 *    elección en la cookie (customer-lang.ts).
 *  - Con JS, al elegir se guarda también aquí (cookie y localStorage, con
 *    try/catch: en privado o con los datos bloqueados puede fallar) y, si la
 *    cookie se perdió pero el navegador lo recuerda, la página se vuelve a
 *    pedir en ese idioma.
 *
 * Sin barras invertidas en el CSS y el JS (van dentro de plantillas).
 */

/** Enlace de la misma página en otro idioma: por defecto, ?lang=xx (sin perder la ruta). */
export type LangHref = (lang: PayLanguage) => string;

export const defaultLangHref: LangHref = (lang) => `?lang=${lang}`;

/** La misma ruta con sus parámetros y el idioma cambiado (p. ej. /pay/result?op=…). */
export function langHrefWith(path: string, params: Readonly<Record<string, string | null | undefined>>): LangHref {
  return (lang) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    qs.set('lang', lang);
    return `${path}?${qs.toString()}`;
  };
}

export const CHROME_CSS = `
.top{display:flex;align-items:center;justify-content:space-between;gap:.75rem;width:100%;max-width:26rem;margin:0 auto;min-height:3.5rem;padding:calc(.4rem + env(safe-area-inset-top)) 1rem .4rem}
.top .wm{height:1.25rem;width:auto}
.top.over{position:absolute;top:0;left:0;right:0;z-index:3;max-width:none}
.lang{position:relative;flex:none}
.lang summary{list-style:none;display:inline-flex;align-items:center;gap:.4rem;min-height:3rem;min-width:3rem;padding:0 .7rem;border:1px solid var(--line-hi);border-radius:999px;color:var(--fg);font-size:.85rem;font-weight:800;letter-spacing:.06em;cursor:pointer;background:rgb(15 17 18/.55)}
.lang summary::-webkit-details-marker{display:none}
.lang summary svg{width:1.05rem;height:1.05rem;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.lang summary:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.lang[open] summary{border-color:var(--fg)}
.lang ul{position:absolute;right:0;top:calc(100% + .4rem);z-index:10;min-width:11rem;margin:0;padding:.35rem;list-style:none;border:1px solid var(--line-hi);border-radius:18px;background:var(--surface-2);box-shadow:0 18px 40px -12px rgb(0 0 0/.7)}
.lang a{display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-height:3rem;padding:0 .9rem;border-radius:12px;color:var(--fg);font-weight:700;text-decoration:none}
.lang a[aria-current=true]{background:var(--surface)}
.lang a[aria-current=true]::after{content:'✓';color:var(--lime);font-weight:900}
.lang a:focus-visible{outline:3px solid var(--fg);outline-offset:-3px}
@media print{.top{display:none!important}}
`;

const GLOBE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

/** El selector: «ES» y la lista con los cuatro idiomas. */
export function langMenu(lang: PayLanguage, hrefFor: LangHref = defaultLangHref): string {
  const label = CUSTOMER_TEXT[lang].pay.languageMenu;
  const items = PAY_LANGUAGES.map((l) => {
    const current = l === lang ? ' aria-current="true"' : '';
    return `<li><a href="${escapeHtml(hrefFor(l))}" lang="${l}" hreflang="${l}" data-lang="${l}"${current}>${escapeHtml(LANGUAGE_NAMES[l])}</a></li>`;
  }).join('');
  return `<details class="lang" id="langMenu"><summary aria-label="${escapeHtml(`${label}: ${LANGUAGE_NAMES[lang]}`)}">${GLOBE}<span aria-hidden="true">${lang.toUpperCase()}</span></summary><ul>${items}</ul></details>`;
}

/** La barra de arriba: logo a la izquierda y el idioma a la derecha. `over`: encima del «Pagado». */
export function topBar(lang: PayLanguage, hrefFor: LangHref = defaultLangHref, opts: { over?: boolean } = {}): string {
  return `<header class="top${opts.over ? ' over' : ''}">${brandWordmark()}${langMenu(lang, hrefFor)}</header>`;
}

/**
 * JS del selector (una vez por página): guarda la elección, cierra la lista
 * con Escape o tocando fuera y recupera el idioma recordado si la cookie se perdió.
 */
export const LANG_JS = `(function(){try{
var K='${LANG_COOKIE}',M=document.getElementById('langMenu'),here=document.documentElement.lang;
function keep(l){try{document.cookie=K+'='+l+'; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE_S}; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');}catch(e){}
 try{localStorage.setItem(K,l);}catch(e){}}
try{var saved=localStorage.getItem(K),has=document.cookie.split(';').some(function(c){return c.trim().indexOf(K+'=')===0;}),q=new URLSearchParams(location.search);
 if(!has&&!q.has('lang')&&/^(es|en|fr|pt)$/.test(saved||'')&&saved!==here){q.set('lang',saved);location.replace(location.pathname+'?'+q.toString());return;}
 if(has||q.has('lang'))localStorage.setItem(K,here);}catch(e){}
if(!M)return;
M.querySelectorAll('a[data-lang]').forEach(function(a){a.addEventListener('click',function(){keep(a.getAttribute('data-lang'));});});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&M.open){M.open=false;M.querySelector('summary').focus();}});
document.addEventListener('click',function(e){if(M.open&&!M.contains(e.target))M.open=false;});
}catch(e){}})();`;

/** <script> del selector. */
export function langScript(): string {
  return `<script>${LANG_JS}</script>`;
}
