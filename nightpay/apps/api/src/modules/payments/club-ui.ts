/**
 * Look "Club" de las páginas del cliente (/pay, /s, /w): negro, lima, letra
 * grande y muy poco más. HTML autocontenido: sin fuentes ni scripts de fuera
 * (la CSP del API solo deja 'self' e inline, y el cliente puede tener mala red).
 *
 * Reglas de movimiento: solo transform/opacity, nada parpadea más de 3 veces
 * por segundo y con "reducir movimiento" no se mueve nada.
 */

/** Fichas de diseño. Las cifras van en tabulares (no bailan al cambiar). */
export const CLUB_TOKENS = `:root{--bg:#0b0b0b;--surface:#151513;--line:#2a2a28;--fg:#f5f5f0;--mute:#b4b4ac;--dim:#93938b;--lime:#d4ff3a;--ink:#0b0b0b;--warn:#ffb020;--err:#ff8a80;--ok:#5be38f;--stale:#2e2e2b;--r:14px;--ease:cubic-bezier(.16,1,.3,1);--num:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color-scheme:dark}`;

/** Base común: cuerpo, botones (≥48 px), enlaces, avisos. */
export const CLUB_BASE_CSS = `${CLUB_TOKENS}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
h1,h2{margin:0;line-height:1.1}
p{margin:0;color:var(--mute)}
a{color:var(--lime)}
.num{font-family:var(--num);font-variant-numeric:tabular-nums}
.kick{font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;min-height:3.5rem;padding:.85rem 1rem;border-radius:12px;border:2px solid var(--lime);background:var(--lime);color:var(--ink);font:inherit;font-size:1.1rem;font-weight:800;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;transition:transform .15s var(--ease)}
.btn:active{transform:scale(.98)}
.btn.alt{background:transparent;color:var(--fg);border-color:#45453f}
.btn:disabled,.btn[aria-disabled=true]{background:#262624;border-color:#262624;color:var(--mute);cursor:progress}
.link{display:inline-flex;align-items:center;justify-content:center;min-height:3rem;padding:0 .75rem;border:0;background:none;color:var(--lime);font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:.2em;cursor:pointer}
.btn:focus-visible,.link:focus-visible,a:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.done{color:var(--ok);font-weight:700}
.err{color:var(--err);font-weight:600}
.foot{font-size:.8rem;color:var(--dim)}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}`;

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
