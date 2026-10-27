import { escapeHtml, jsConfig } from './club-ui';
import type { PayText } from './pay-i18n';

/**
 * «Pagado» a pantalla completa: la prueba que el cliente enseña a un metro.
 *
 *  - Lo primero, el CÓDIGO DE CONFIRMACIÓN, enorme, en una placa crema con
 *    tinta (≈ 12:1 de contraste, legible con poca luz), letras separadas y
 *    tabulares, y «Enséñaselo al personal». El código es el mismo del
 *    personal (contracts/confirmation-code: 3 cifras hexadecimales, sin O ni
 *    I ni L); aquí no se le añade nada.
 *  - Recién pagado: el verde de la marca con el aro lima, «PAGADO» y el
 *    importe en crema, «hace 0:12» desde que el banco lo autorizó, la hora
 *    con segundos y una franja que se mueve despacio (una captura vieja no se
 *    mueve ni tiene la hora buena). La pantalla no se apaga (Wake Lock)
 *    mientras está a la vista. Solo en el navegador que pagó (`viewerPaid`).
 *  - Pasados PAID_FRESH_MS, o en cualquier otro navegador (un /pay reenviado,
 *    el /s de otro móvil): gris, «YA PAGADO · hace 23 min» y «No es un pago
 *    nuevo». El estado lo dice el texto, no solo el color.
 *  - Debajo del importe, su desglose (consumo, comisión del servicio,
 *    propina) y, al final de la pantalla, el enlace al justificante.
 *
 * Funciona sin red una vez cargado (CSS y JS en la página) y sin JS se ve el
 * importe y el código. El reloj usa la hora del servidor (data-now).
 */

/** Tiempo durante el que «Pagado» se ve en verde con el aro lima (recién pagado). */
export const PAID_FRESH_MS = 3 * 60_000;

export const PAID_SCREEN_CSS = `
.paid{position:relative;isolation:isolate;overflow:hidden;width:100%;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.45rem;padding:4.25rem 1rem calc(1.75rem + env(safe-area-inset-bottom));background:radial-gradient(120% 80% at 50% 32%,var(--green-3) 0%,var(--green-2) 55%,var(--green-1) 100%);background-color:var(--green-2);color:var(--cream);text-align:center}
.paid p{color:inherit}
.paid .band{position:absolute;top:-50%;left:-50%;width:200%;height:200%;z-index:-1;background:repeating-linear-gradient(-45deg,rgb(239 233 223/.05) 0 30px,rgb(239 233 223/0) 30px 60px);animation:np-band 8s linear infinite;will-change:transform}
@keyframes np-band{from{transform:translate3d(0,0,0)}to{transform:translate3d(84.85px,0,0)}}
@keyframes np-fade{from{opacity:.2}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.paid .band{animation:np-fade 3s ease-in-out infinite alternate}}
.paid .phead{display:flex;align-items:center;justify-content:center;gap:.7rem}
.paid .tick{flex:none;width:3.4rem;height:3.4rem;padding:.8rem;border-radius:50%;background:var(--lime);color:var(--ink);box-shadow:0 0 0 7px var(--lime-ring),0 0 40px 6px var(--lime-glow);stroke:currentColor;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.paid .ptitle{font-size:clamp(2.3rem,12vw,3.6rem);font-weight:800;letter-spacing:.01em;text-transform:uppercase;line-height:.95}
.paid .pamount{font-size:clamp(2.3rem,12.5vw,3.6rem);font-weight:800;letter-spacing:-.035em;line-height:1.05}
.paid .pcode{width:100%;max-width:21rem;margin:.55rem 0 .35rem;padding:.75rem 1rem .85rem;border-radius:22px;background:var(--cream);color:var(--ink);display:flex;flex-direction:column;align-items:center;gap:.1rem;box-shadow:0 0 0 3px var(--lime),0 18px 40px -16px rgb(0 0 0/.6)}
.paid .pcode .plabel{font-size:.8rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.paid .pcode b{display:block;font-size:clamp(4.2rem,24vw,6.2rem);font-weight:800;line-height:1;letter-spacing:.16em;margin-right:-.16em;font-variant-numeric:tabular-nums}
.paid .pcode .phint{font-size:1.05rem;font-weight:800}
.paid .ptime{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:.1rem .9rem}
.paid .pago{font-size:1.6rem;font-weight:800;line-height:1.1}
.paid .pclock{font-size:1.2rem;font-weight:700}
.paid [data-lines]{display:flex;flex-direction:column;align-items:center;gap:.35rem}
.paid [data-lines]:empty{display:none}
.paid .pline{display:inline-flex;align-items:center;min-height:2.5rem;padding:.3rem 1.1rem;border-radius:999px;background:rgb(0 0 0/.24);font-size:1.02rem;font-weight:700}
.paid .prows{width:100%;max-width:21rem;margin:.2rem 0 0;padding:.15rem .9rem;border-radius:16px;background:rgb(0 0 0/.22);text-align:left}
.paid .prows div{display:flex;justify-content:space-between;gap:1rem;padding:.35rem 0;font-size:.95rem}
.paid .prows div+div{border-top:1px solid rgb(239 233 223/.16)}
.paid .prows dt{font-weight:600}
.paid .prows dd{margin:0;font-weight:800;font-variant-numeric:tabular-nums}
.paid .pnote{font-size:.9rem;font-weight:600}
.paid .pstale{display:none;font-weight:800}
.paid .pfoot{margin-top:.4rem}
.paid .pfoot .link{color:inherit}
.paid.stale{background:var(--stale);color:var(--fg)}
.paid.stale .band{display:none}
.paid.stale .tick{background:transparent;color:var(--fg);box-shadow:inset 0 0 0 3px currentColor}
.paid.stale .pcode{box-shadow:0 0 0 3px var(--line-hi)}
.paid.stale .pline,.paid.stale .prows{background:rgb(0 0 0/.2)}
.paid.stale .pstale{display:block}
`;

/**
 * JS del «Pagado»: npAgo(ms, T) da «hace 0:12» / «hace 23 min»; npPaid(el, T)
 * pone en marcha el contador, el reloj, el paso a «Ya pagado» y el Wake Lock.
 * Sin barras invertidas (va dentro de una plantilla de TypeScript).
 */
export const PAID_SCREEN_JS = `
function npAgo(ms,T){var s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60),h=Math.floor(m/60),u=T.agoUnits,v;
 if(s<600)v=m+':'+('0'+s%60).slice(-2);else if(m<60)v=m+' '+u.min;else if(h<24)v=h+' '+u.h+' '+('0'+m%60).slice(-2)+' '+u.min;else v=Math.floor(h/24)+' '+u.d;
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
export function formatAgo(ms: number, t: Pick<PayText, 'agoPrefix' | 'agoSuffix' | 'agoUnits'>): string {
  const u = t.agoUnits;
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  let v: string;
  if (s < 600) v = `${m}:${String(s % 60).padStart(2, '0')}`;
  else if (m < 60) v = `${m} ${u.min}`;
  else if (h < 24) v = `${h} ${u.h} ${String(m % 60).padStart(2, '0')} ${u.min}`;
  else v = `${Math.floor(h / 24)} ${u.d}`;
  return `${t.agoPrefix}${v}${t.agoSuffix}`;
}

/** Textos que necesita el JS del «Pagado». */
export function paidScreenJsText(t: PayText): Record<string, unknown> {
  return {
    locale: t.locale,
    alreadyPaidTitle: t.alreadyPaidTitle,
    agoPrefix: t.agoPrefix,
    agoSuffix: t.agoSuffix,
    agoUnits: t.agoUnits,
  };
}

export interface PaidScreenArgs {
  t: PayText;
  /** Importe ya formateado ("65 €"); vacío si lo pone el JS (/s). */
  amount: string;
  /** Cuándo lo autorizó el banco (null = no consta: se pinta como ya pagado). */
  authorizedAt: Date | null;
  now: Date;
  /** Código que también ve el personal (null = sin código). */
  code: string | null;
  /** Desglose debajo del importe (Consumo, Comisión del servicio, Propina), ya formateado. */
  rows?: ReadonlyArray<readonly [string, string]>;
  /** Líneas debajo del importe (texto plano): «¡Gracias por la propina!», «Te quedan…». */
  lines?: string[];
  id?: string;
  /** Oculto al cargar (lo enseña el JS, p. ej. tras pagar en /s). */
  hidden?: boolean;
  /** Pagado con el saldo (/s): «Pagado con tu saldo a las…» en vez de «Confirmado por el banco…». */
  fromBalance?: boolean;
  /** Este navegador es el que pagó: solo entonces puede salir lima (si no, siempre «Ya pagado»). */
  viewerPaid?: boolean;
  /** HTML al final de la pantalla (el enlace al justificante). */
  footer?: string;
}

function formatClock(d: Date, t: PayText): string {
  return d.toLocaleTimeString(t.locale, { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTime(d: Date, t: PayText): string {
  return d.toLocaleTimeString(t.locale, { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

/** La placa del código (también la arma el JS de /s al pagar: mismas clases). */
export function codePlate(code: string, t: PayText): string {
  return `<div class="pcode" data-code><span class="plabel">${escapeHtml(t.codeLabel)}</span><b class="num">${escapeHtml(code)}</b><span class="phint">${escapeHtml(t.codeHint)}</span></div>`;
}

/** La sección «Pagado» (sin <script>: la página llama a npPaid). */
export function renderPaidScreen(a: PaidScreenArgs): string {
  const { t } = a;
  const id = a.id ?? 'paid';
  const at = a.authorizedAt?.getTime() ?? null;
  const fresh = a.viewerPaid === true && at !== null && a.now.getTime() - at < PAID_FRESH_MS;
  const lines = (a.lines ?? []).map((l) => `<p class="pline">${escapeHtml(l)}</p>`).join('');
  const rows = a.rows?.length
    ? `<dl class="prows">${a.rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd class="num">${escapeHtml(v)}</dd></div>`).join('')}</dl>`
    : '';
  return `<section class="paid${fresh ? '' : ' stale'}" id="${id}" data-at="${at ?? ''}" data-now="${a.now.getTime()}" data-fresh="${PAID_FRESH_MS}" aria-labelledby="${id}Title"${a.hidden ? ' hidden' : ''}>
<div class="band" aria-hidden="true"></div>
<div class="phead"><svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg><h1 class="ptitle" id="${id}Title" data-title aria-live="polite">${escapeHtml(fresh ? t.paidTitle : t.alreadyPaidTitle)}</h1></div>
<p class="pamount num" data-amount>${escapeHtml(a.amount)}</p>
${a.code ? codePlate(a.code, t) : ''}
<p class="pstale">${escapeHtml(t.notNewPayment)}</p>
<div class="ptime"><p class="pago num" data-ago>${at !== null ? escapeHtml(formatAgo(a.now.getTime() - at, t)) : ''}</p><p class="pclock num" data-clock aria-label="${escapeHtml(t.clockLabel)}">${escapeHtml(formatClock(a.now, t))}</p></div>
${rows}<div data-lines>${lines}</div>
${a.authorizedAt ? `<p class="pnote">${escapeHtml((a.fromBalance ? t.paidFromBalanceAt : t.confirmedAt)(formatTime(a.authorizedAt, t)))}</p>` : ''}
${a.footer ? `<div class="pfoot">${a.footer}</div>` : ''}
</section>`;
}

/** <script> que arranca el «Pagado» ya pintado en el HTML. */
export function paidScreenScript(t: PayText, id = 'paid'): string {
  return `<script>
${PAID_SCREEN_JS}
npPaid(document.getElementById(${JSON.stringify(id)}),JSON.parse(${jsConfig(paidScreenJsText(t))}));
</script>`;
}
