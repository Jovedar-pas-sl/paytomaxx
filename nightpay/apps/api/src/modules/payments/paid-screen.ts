import { escapeHtml, jsConfig } from './club-ui';
import type { PayText } from './pay-i18n';

/**
 * «Pagado» a pantalla completa: la prueba que el cliente enseña a un metro.
 *
 *  - Recién pagado: lima, «PAGADO» y el importe enormes en negro, «hace 0:12»
 *    desde que el banco lo autorizó, la hora con segundos y una franja que se
 *    mueve despacio (una captura vieja no se mueve ni tiene la hora buena).
 *    La pantalla no se apaga (Wake Lock) mientras está a la vista. Solo en el
 *    navegador que pagó (`viewerPaid`: su cookie del intento aprobado en /pay,
 *    la respuesta del pago en /s).
 *  - Pasados PAID_FRESH_MS, o en cualquier otro navegador (un /pay reenviado,
 *    el /s de la chica abierto en otro móvil): gris, «YA PAGADO · hace 23 min»
 *    y «No es un pago nuevo» (no cuela como nuevo). El estado lo dice el
 *    texto, no solo el color.
 *
 * Funciona sin red una vez cargado (CSS y JS en la página). El reloj usa la
 * hora del servidor (data-now) para no depender de la del móvil.
 */

/*
 * Ocupa la pantalla menos una franja de abajo: así asoma lo que sigue
 * (justificante, activar Face ID) y el cliente sabe que hay más.
 */

/** Tiempo durante el que «Pagado» se ve lima (recién pagado). */
export const PAID_FRESH_MS = 3 * 60_000;

export const PAID_SCREEN_CSS = `
.paid{position:relative;isolation:isolate;overflow:hidden;width:100%;min-height:calc(100vh - 4.5rem);min-height:calc(100svh - 4.5rem);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.4rem;padding:2.5rem 1rem calc(2.5rem + env(safe-area-inset-bottom));background:var(--lime);color:var(--ink);text-align:center}
.paid p{color:inherit}
.paid .band{position:absolute;top:-50%;left:-50%;width:200%;height:200%;z-index:-1;background:repeating-linear-gradient(-45deg,rgba(11,11,11,.09) 0 30px,rgba(11,11,11,0) 30px 60px);animation:np-band 8s linear infinite;will-change:transform}
@keyframes np-band{from{transform:translate3d(0,0,0)}to{transform:translate3d(84.85px,0,0)}}
@keyframes np-fade{from{opacity:.2}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.paid .band{animation:np-fade 3s ease-in-out infinite alternate}}
.paid .tick{width:3.25rem;height:3.25rem;stroke:currentColor;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.paid .ptitle{font-size:clamp(2.6rem,14vw,5rem);font-weight:900;letter-spacing:-.01em;text-transform:uppercase;line-height:.95}
.paid .pamount{font-size:clamp(2.6rem,14vw,4.75rem);font-weight:800;letter-spacing:-.02em;line-height:1.05}
.paid .pline{font-size:1.05rem;font-weight:700}
.paid .pago{margin-top:.6rem;font-size:1.75rem;font-weight:800;line-height:1.1}
.paid .pclock{font-size:1.2rem;font-weight:700}
.paid .pcode{margin-top:.8rem;border:2px solid currentColor;border-radius:12px;padding:.55rem 1.1rem .65rem;display:flex;flex-direction:column;align-items:center}
.paid .pcode span,.paid .pcode small,.paid .pnote{font-size:.85rem;font-weight:600}
.paid .pcode b{font-size:2.2rem;line-height:1.1;letter-spacing:.25em;margin-right:-.25em}
.paid .pstale{display:none;font-weight:800}
.paid.stale{background:var(--stale);color:var(--fg)}
.paid.stale .band{display:none}
.paid.stale .pstale{display:block}
`;

/**
 * JS del «Pagado»: npAgo(ms, T) da «hace 0:12» / «hace 23 min»; npPaid(el, T)
 * pone en marcha el contador, el reloj, el paso a «Ya pagado» y el Wake Lock.
 * Sin barras invertidas (va dentro de una plantilla de TypeScript).
 */
export const PAID_SCREEN_JS = `
function npAgo(ms,T){var s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60),h=Math.floor(m/60),v;
 if(s<600)v=m+':'+('0'+s%60).slice(-2);else if(m<60)v=m+' min';else if(h<24)v=h+' h '+('0'+m%60).slice(-2)+' min';else v=Math.floor(h/24)+' d';
 return T.agoPrefix+v+T.agoSuffix;}
function npPaid(el,T){
 var at=+el.getAttribute('data-at')||0,skew=(+el.getAttribute('data-now')||Date.now())-Date.now(),fresh=+el.getAttribute('data-fresh'),
  ago=el.querySelector('[data-ago]'),clock=el.querySelector('[data-clock]'),title=el.querySelector('[data-title]'),
  stale=el.classList.contains('stale'),lock=null,iv;
 function release(){if(lock){lock.release().catch(function(){});lock=null;}}
 function wake(){if(stale||lock||!navigator.wakeLock||document.visibilityState!=='visible')return;
  navigator.wakeLock.request('screen').then(function(l){if(stale){l.release().catch(function(){});return;}lock=l;l.addEventListener('release',function(){lock=null;});}).catch(function(){});}
 function goStale(){stale=true;el.classList.add('stale');title.textContent=T.alreadyPaidTitle;release();}
 function tick(){var now=Date.now()+skew;
  clock.textContent=new Date(now).toLocaleTimeString(T.locale,{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  if(at){ago.textContent=npAgo(now-at,T);if(!stale&&now-at>=fresh)goStale();}}
 document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')wake();});
 tick();wake();clearInterval(el.npIv);iv=setInterval(tick,500);el.npIv=iv;
}
`;

/** «hace 0:12» / «hace 23 min» (lo mismo que npAgo, para pintarlo ya en el HTML). */
export function formatAgo(ms: number, t: Pick<PayText, 'agoPrefix' | 'agoSuffix'>): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  let v: string;
  if (s < 600) v = `${m}:${String(s % 60).padStart(2, '0')}`;
  else if (m < 60) v = `${m} min`;
  else if (h < 24) v = `${h} h ${String(m % 60).padStart(2, '0')} min`;
  else v = `${Math.floor(h / 24)} d`;
  return `${t.agoPrefix}${v}${t.agoSuffix}`;
}

/** Textos que necesita el JS del «Pagado». */
export function paidScreenJsText(t: PayText): Record<string, string> {
  return { locale: t.locale, alreadyPaidTitle: t.alreadyPaidTitle, agoPrefix: t.agoPrefix, agoSuffix: t.agoSuffix };
}

export interface PaidScreenArgs {
  t: PayText;
  /** Importe ya formateado ("65,00 €"); vacío si lo pone el JS (/s). */
  amount: string;
  /** Cuándo lo autorizó el banco (null = no consta: se pinta como ya pagado). */
  authorizedAt: Date | null;
  now: Date;
  /** Código que también ve el personal (null = sin código). */
  code: string | null;
  /** Líneas debajo del importe (texto plano): propina, «Te quedan…». */
  lines?: string[];
  id?: string;
  /** Oculto al cargar (lo enseña el JS, p. ej. tras pagar en /s). */
  hidden?: boolean;
  /** Pagado con el saldo (/s): «Pagado con tu saldo a las…» en vez de «Confirmado por el banco…». */
  fromBalance?: boolean;
  /** Este navegador es el que pagó: solo entonces puede salir lima (si no, siempre «Ya pagado»). */
  viewerPaid?: boolean;
}

function formatClock(d: Date, t: PayText): string {
  return d.toLocaleTimeString(t.locale, { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTime(d: Date, t: PayText): string {
  return d.toLocaleTimeString(t.locale, { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

/** La sección «Pagado» (sin <script>: la página llama a npPaid). */
export function renderPaidScreen(a: PaidScreenArgs): string {
  const { t } = a;
  const id = a.id ?? 'paid';
  const at = a.authorizedAt?.getTime() ?? null;
  const fresh = a.viewerPaid === true && at !== null && a.now.getTime() - at < PAID_FRESH_MS;
  const lines = (a.lines ?? []).map((l) => `<p class="pline">${escapeHtml(l)}</p>`).join('');
  return `<section class="paid${fresh ? '' : ' stale'}" id="${id}" data-at="${at ?? ''}" data-now="${a.now.getTime()}" data-fresh="${PAID_FRESH_MS}" aria-labelledby="${id}Title"${a.hidden ? ' hidden' : ''}>
<div class="band" aria-hidden="true"></div>
<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>
<h1 class="ptitle" id="${id}Title" data-title aria-live="polite">${escapeHtml(fresh ? t.paidTitle : t.alreadyPaidTitle)}</h1>
<p class="pamount num" data-amount>${escapeHtml(a.amount)}</p>
<div data-lines>${lines}</div>
<p class="pago num" data-ago>${at !== null ? escapeHtml(formatAgo(a.now.getTime() - at, t)) : ''}</p>
<p class="pclock num" data-clock aria-label="${escapeHtml(t.clockLabel)}">${escapeHtml(formatClock(a.now, t))}</p>
${a.code ? `<div class="pcode"><span>${escapeHtml(t.codeLabel)}</span><b class="num">${escapeHtml(a.code)}</b><small>${escapeHtml(t.codeHint)}</small></div>` : ''}
<p class="pstale">${escapeHtml(t.notNewPayment)}</p>
${a.authorizedAt ? `<p class="pnote">${escapeHtml((a.fromBalance ? t.paidFromBalanceAt : t.confirmedAt)(formatTime(a.authorizedAt, t)))}</p>` : ''}
</section>`;
}

/** <script> que arranca el «Pagado» ya pintado en el HTML. */
export function paidScreenScript(t: PayText, id = 'paid'): string {
  return `<script>
${PAID_SCREEN_JS}
npPaid(document.getElementById(${JSON.stringify(id)}),JSON.parse(${jsConfig(paidScreenJsText(t))}));
</script>`;
}
