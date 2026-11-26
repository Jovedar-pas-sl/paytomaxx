import { formatMoney } from '@nightpay/contracts';
import { BRAND_FONT_FACE } from './brand-font';
import { OXIOPAY_WORDMARK } from './brand-logo';

/**
 * Look de las páginas del cliente (/pay, /s, /w, /r): dirección «Grafito»,
 * la de las apps, con la paleta de «Color y relieve» (25-nov-2026): suelo azul
 * noche, filetes finos y la lima como única luz encendida: el botón de
 * actuar, y nada más en esa vista (ni el total, ni los antetítulos, ni los
 * iconos). El único relieve es el del botón principal (el mismo que en las
 * apps); sin más degradados ni halos, ni el motivo 0101: el cliente da aquí
 * su tarjeta y tiene que parecer un pago serio. HTML
 * autocontenido: sin fuentes ni scripts de fuera (la CSP del API solo deja
 * 'self' e inline, y el cliente puede tener mala red); el logo va como data:
 * URI. El texto en Instrument Sans 400/500/600 y las cifras en Manrope
 * 600/700, las dos servidas por el propio API (brand-font.ts); nunca 800 ni
 * 900 (en la letra del sistema salía casi negra).
 *
 * Reglas de movimiento: solo transform/opacity, nada parpadea más de 3 veces
 * por segundo y con "reducir movimiento" no se mueve nada.
 */

/**
 * Fichas de diseño (las mismas que --np-* del tema oscuro de @nightpay/ui;
 * club-ui.spec.ts comprueba que no se separan). Contraste sobre --bg: --fg
 * 15,4:1, --mute 11,5:1, --dim 9,2:1 (pies y ayudas: el alcohol baja la
 * sensibilidad al contraste), --err 9,1:1, lima 11,3:1; bordes --line-hi
 * 5,8:1; tinta sobre lima (--on-lime) 11,3:1; texto sobre el verde de
 * «Pagado» 11:1. Radios: 6 chips, 10 campos, 14 lo partido en dos y las
 * losetas, 18 tarjetas y hojas; los botones, píldora.
 * Sombras, solo dos: la de la hoja y la del diálogo.
 */
export const CLUB_TOKENS = `:root{--bg:#091518;--surface:#19272b;--surface-2:#223035;--surface-3:#2b3b40;--line:#314045;--line-hi:#7f939a;--fg:#efe9df;--label:#cfcbc2;--mute:#cfcbc2;--dim:#bab6ad;--lime:#c7d301;--on-lime:#091518;--ink:#1f2c36;--ink-0:#0f1112;--cream:#efe9df;--paid:#0b3d24;--paid-ink:#f4f2ec;--fail:#7a1c20;--warn:#f5b342;--err:#ff9a94;--bad:#ff6b6b;--ok:#58d68d;--stale:#2b3b40;--scrim:rgba(3,10,12,.74);--r:18px;--r-tile:14px;--r-field:10px;--r-chip:6px;--sh-sheet:0 -12px 32px rgb(0 0 0/.5);--sh-dialog:0 16px 40px -12px rgb(0 0 0/.7);--ease:cubic-bezier(.16,1,.3,1);--sys:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--sans:'OxioSans',var(--sys);--num:'OxioManrope',var(--sys);color-scheme:dark}`;

/**
 * Base común: cuerpo, botones, enlaces, avisos y la barra con el logo.
 *
 * Los botones, los mismos que en las apps: 56 px de alto (≥48 px siempre),
 * en píldora, 17/600 y cifras tabulares (el importe del botón no baila al
 * cambiar). El principal, lima con su tinta, el brillo arriba y la sombra con
 * un resplandor lima suave; el secundario (.alt), superficie con filete de
 * 1 px y un filo de luz. Quien cambie el fondo de un .btn tiene que poner
 * también su box-shadow (si no, hereda el resplandor lima). Al pulsar se hunde un poco y se oscurece; desactivado, gris de verdad
 * (sin opacidad: a oscuras, un botón translúcido parece roto); ocupado
 * (.busy), su color con una ruedita en vez del icono, que no se pulsa dos
 * veces. Iconos de trazo: .ic. Los errores, en una caja con filete rojo y el
 * texto en el color normal (se lee mejor que el rojo sobre oscuro).
 */
export const CLUB_BASE_CSS = `${BRAND_FONT_FACE}${CLUB_TOKENS}
:root{--r-btn:14px}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.5 var(--sans)}
h1,h2{margin:0;font-family:var(--sans);line-height:1.15;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--mute)}
a{color:var(--fg)}
b,strong{font-weight:600}
.num{font-family:var(--num);font-variant-numeric:tabular-nums}
.kick{font-size:.875rem;font-weight:500;color:var(--label)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;min-height:3.5rem;padding:.75rem 1.25rem;border-radius:999px;border:1px solid var(--lime);background:var(--lime) linear-gradient(180deg,rgba(255,255,255,.24),rgba(255,255,255,0) 55%);color:var(--on-lime);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),inset 0 -1px 0 rgba(0,0,0,.18),0 1px 2px rgba(0,0,0,.4),0 8px 24px -8px rgba(199,211,1,.5);font:inherit;font-size:1.0625rem;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;text-align:center;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s var(--ease),filter .12s var(--ease)}
.ic{flex:none;width:1.15em;height:1.15em;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
@media (hover:hover){.btn:hover{filter:brightness(1.06)}}
.btn:active{transform:translateY(1px);filter:brightness(.93)}
.btn.alt{min-height:3rem;background:var(--surface-2);color:var(--fg);border-color:var(--line-hi);box-shadow:inset 0 1px 0 rgba(239,233,223,.08);font-weight:500}
.btn.alt:active{background:var(--surface-3);filter:none}
.btn:disabled:not(.busy),.btn[aria-disabled=true]:not(.busy){background:var(--surface-2);border-color:var(--line);color:var(--dim);box-shadow:none;filter:none;transform:none;cursor:not-allowed}
.btn.busy{cursor:progress;transform:none;filter:none}
.btn.busy .ic{display:none}
.btn.busy::before{content:'';flex:none;width:1.1rem;height:1.1rem;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:np-spin .9s linear infinite}
@keyframes np-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.btn.busy::before{animation:none;border-right-color:currentColor;opacity:.6}}
.link{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 .75rem;border:0;background:none;color:var(--mute);font:inherit;font-size:.9375rem;font-weight:500;text-decoration:underline;text-underline-offset:.2em;cursor:pointer}
.btn:focus-visible,.link:focus-visible,a:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.done{color:var(--ok);font-weight:600}
.err{margin:0;padding:.75rem .875rem;border:1px solid var(--bad);border-radius:var(--r-field);background:rgb(255 107 107/.1);color:var(--fg);font-size:.875rem;font-weight:500;line-height:1.35;text-align:left}
.foot{font-size:.875rem;color:var(--dim)}
.wm{display:block;width:auto;height:calc(1.25rem*51/43);margin-bottom:calc(-1.25rem*8/43)}
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

/** El wordmark de OxioPay (claro, para fondo oscuro). alt vacío si al lado ya pone la marca en texto. */
export function brandWordmark(alt = 'OxioPay'): string {
  const w = OXIOPAY_WORDMARK;
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
