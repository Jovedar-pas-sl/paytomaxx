import { formatMoney } from '@nightpay/contracts';
import { BRAND_FONT_FACE } from './brand-font';
import { OXIOCARD_WORDMARK } from './brand-logo';

/**
 * Look de las páginas del cliente (/pay, /s, /w): marca OxioCard, la de las
 * maquetas aprobadas. Noche azulada, botón principal en pill lima con tinta,
 * «Pagado» en el verde de la marca y letra grande. HTML autocontenido: sin
 * fuentes ni scripts de fuera (la CSP del API solo deja 'self' e inline, y el
 * cliente puede tener mala red); el logo va como data: URI. Importes y
 * títulos en Manrope 800, la de la marca (como en el móvil del personal),
 * servida por el propio API (brand-font.ts); el texto, con la del móvil.
 *
 * Reglas de movimiento: solo transform/opacity, nada parpadea más de 3 veces
 * por segundo y con "reducir movimiento" no se mueve nada.
 */

/** Motivo 0101 de la «o» del logo, muy tenue (textura de la tarjeta del saldo). */
const BITS = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='132' height='64'%3E%3Cg font-family='monospace' font-size='11' fill='%23EFE9DF' fill-opacity='.045'%3E%3Ctext x='2' y='12'%3E0101 1001 0110%3C/text%3E%3Ctext x='-12' y='28'%3E1100 1010 0101 1%3C/text%3E%3Ctext x='6' y='44'%3E0110 0101 1001%3C/text%3E%3Ctext x='-6' y='60'%3E1001 0011 0101 0%3C/text%3E%3C/g%3E%3C/svg%3E")`;

/**
 * Fichas de diseño (las mismas que --np-* del tema oscuro de @nightpay/ui;
 * club-ui.spec.ts comprueba que no se separan). Contraste sobre --bg: --fg
 * 16:1, --mute 11,6:1, --dim 8,6:1 (pies y ayudas: el alcohol baja la
 * sensibilidad al contraste), --err 7,6:1, lima 11:1; bordes --line-hi
 * 3,5:1; tinta sobre lima 8,7:1; crema sobre el verde más claro 5,5:1. Las
 * cifras van en tabulares (no bailan al cambiar).
 */
export const CLUB_TOKENS = `:root{--bg:#0f1112;--surface:#15181b;--surface-2:#1c2024;--line:#2a3036;--line-hi:#616c77;--fg:#f2efe9;--label:#cdd3d8;--mute:#c4cbd1;--dim:#a7b0b8;--lime:#c7d301;--lime-soft:rgb(199 211 1/.14);--lime-edge:rgb(199 211 1/.55);--lime-glow:rgb(199 211 1/.32);--lime-ring:rgb(199 211 1/.22);--ink:#1f2c36;--ink-0:#0f1112;--cream:#efe9df;--green-1:#003818;--green-2:#004820;--green-3:#0a6b34;--warn:#ffb020;--err:#ff7b7b;--bad:#ff5a5f;--ok:#5be38f;--stale:#2c3136;--scrim:rgb(8 16 24/.74);--bits:${BITS};--r:22px;--r-tile:20px;--ease:cubic-bezier(.16,1,.3,1);--sys:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--num:'OxioManrope',var(--sys);color-scheme:dark}`;

/** Base común: cuerpo, botones (≥48 px, en pill), enlaces, avisos y la barra con el logo. */
export const CLUB_BASE_CSS = `${BRAND_FONT_FACE}${CLUB_TOKENS}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.45 var(--sys)}
h1,h2{margin:0;font-family:var(--num);line-height:1.1;font-weight:800;letter-spacing:-.01em}
p{margin:0;color:var(--mute)}
a{color:var(--fg)}
.num{font-family:var(--num);font-variant-numeric:tabular-nums}
.kick{font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--label)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;min-height:3.5rem;padding:.85rem 1.5rem;border-radius:999px;border:2px solid var(--lime);background:var(--lime);color:var(--ink);font:inherit;font-size:1.1rem;font-weight:800;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;box-shadow:0 10px 28px -12px var(--lime-glow);transition:transform .15s var(--ease)}
.btn:active{transform:scale(.98)}
.btn.alt{background:transparent;color:var(--fg);border-color:var(--line-hi);box-shadow:none}
.btn:disabled,.btn[aria-disabled=true]{background:var(--surface-2);border-color:var(--surface-2);color:var(--mute);box-shadow:none;cursor:progress}
.link{display:inline-flex;align-items:center;justify-content:center;min-height:3rem;padding:0 .75rem;border:0;background:none;color:var(--fg);font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:.2em;cursor:pointer}
.btn:focus-visible,.link:focus-visible,a:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.done{color:var(--ok);font-weight:700}
.err{color:var(--err);font-weight:600}
.foot{font-size:.85rem;color:var(--dim)}
.wm{display:block;width:auto;height:1.25rem}
.brand{position:absolute;top:calc(1.1rem + env(safe-area-inset-top));left:0;right:0;display:flex;justify-content:center;pointer-events:none}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}`;

/**
 * npMoney(cents, locale, currency, full): el mismo formato que formatMoney de
 * @nightpay/contracts, para el JS de las páginas: «33 €» sin céntimos (como
 * en el móvil del personal), «33,50 €», miles con punto («1.109 €») y «−12 €»
 * con el signo menos de verdad; `full` fuerza los céntimos.
 */
export const MONEY_JS = `function npMoney(c,L,cur,full){var d=!full&&c%100===0?0:2,s;
 try{s=new Intl.NumberFormat(L,{style:'currency',currency:cur||'EUR',minimumFractionDigits:d,maximumFractionDigits:d,useGrouping:'always'}).format(c/100);}
 catch(e){s=(c/100).toFixed(d)+' '+(cur||'EUR');}
 return s.replace('-','−');}`;

/** Lo mismo en el servidor (lo que se pinta ya en el HTML): «33 €», «33,50 €», «1.109 €», «−12 €». */
export function clientMoney(cents: number, locale: string, currency = 'EUR', full = false): string {
  return formatMoney(cents, { compact: !full, locale, currency });
}

/** El wordmark de OxioCard (claro, para fondo oscuro). alt vacío si al lado ya pone la marca en texto. */
export function brandWordmark(alt = 'OxioCard'): string {
  const w = OXIOCARD_WORDMARK;
  return `<img class="wm" src="${w.src}" width="${w.width}" height="${w.height}" alt="${escapeHtml(alt)}">`;
}

/** Barra con el logo arriba de la página (no ocupa sitio: la página deja hueco arriba). */
export function brandBar(): string {
  return `<header class="brand">${brandWordmark()}</header>`;
}

/** Texto dentro de HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** Para meter un valor en un <script>: JSON sin poder cerrar la etiqueta. */
export function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c');
}

/** Objeto para un <script>: se lee con JSON.parse(...). */
export function jsConfig(value: unknown): string {
  return jsString(JSON.stringify(value));
}
