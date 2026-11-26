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
 *  - Recién pagado: verde plano y profundo (texto 11:1), la marca lima sin
 *    halo, «Pagado» y el importe, «hace 0:12» desde que el banco lo
 *    autorizó, la hora con segundos y una marquesina fina con la palabra y la
 *    hora que se mueve despacio (una captura vieja no se mueve ni tiene la
 *    hora buena). La pantalla no se apaga (Wake Lock) mientras está a la
 *    vista. Solo en el navegador que pagó (`viewerPaid`).
 *  - Pasados PAID_FRESH_MS, o en cualquier otro navegador (un /pay reenviado,
 *    el /s de otro móvil): gris, «YA PAGADO · hace 23 min» y «No es un pago
 *    nuevo». El estado lo dice el texto, no solo el color.
 *  - Debajo del título, a quién se pagó («a Sala Aurora», idea 62). Debajo
 *    del importe, su desglose: lo pedido (o «Consumo»), la comisión del
 *    servicio, la propina y cómo se pagó («Visa · Apple Pay o Google Pay»,
 *    nunca los dígitos de la tarjeta). Al final de la pantalla, el enlace al
 *    justificante.
 *
 * Funciona sin red una vez cargado (CSS y JS en la página) y sin JS se ve el
 * importe y el código. El reloj usa la hora del servidor (data-now).
 */

/** Tiempo durante el que «Pagado» se ve en verde con el aro lima (recién pagado). */
export const PAID_FRESH_MS = 3 * 60_000;

/** A los 5 min el «Pagado» se cierra: solo «Pago terminado» y el justificante (decisión del dueño, 17-nov). */
export const PAID_CLOSE_MS = 5 * 60_000;

/**
 * La marquesina antifraude (aquí y en el «Pagado» de la recarga, en /w): una
 * franja fina con la palabra y la hora que se desplaza despacio (unos 60
 * px/s); con «reducir movimiento», no se desplaza: se funde despacio. Solo
 * transform/opacity.
 */
export const BAND_CSS = `
.band{overflow:hidden;display:flex;align-items:center;background:rgb(0 0 0/.2)}
.band>span{display:flex;flex:none;white-space:nowrap;font-size:.8125rem;font-weight:600;line-height:1;animation:np-band 28s linear infinite;will-change:transform}
.band i{font-style:normal;padding-right:2rem}
@keyframes np-band{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}
@keyframes np-fade{from{opacity:.3}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.band>span{animation:np-fade 2.5s ease-in-out infinite alternate}}
`;

/** Veces que se repite el texto en cada mitad de la marquesina (llena un escritorio ancho). */
const BAND_ITEMS = 10;

/** La marquesina: dos mitades iguales, para que el bucle no salte. */
export function paidBand(text: string): string {
  const item = `<i>${escapeHtml(text)}</i>`;
  return `<div class="band" aria-hidden="true"><span>${item.repeat(BAND_ITEMS * 2)}</span></div>`;
}

/*
 * El «Pagado» a pantalla completa: verde plano (--paid) con texto claro, la
 * marca lima de 56 px sin halo encima de la palabra (28/600), el importe en
 * 56-64/600 con cifras proporcionales y la placa crema del código (72-96/700).
 * La marquesina va pegada debajo de la barra del logo. Con todo, cabe en
 * 360×740 con el justificante a la vista.
 */
export const PAID_SCREEN_CSS = `${BAND_CSS}
.paid{position:relative;isolation:isolate;overflow:hidden;width:100%;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;padding:calc(5.75rem + env(safe-area-inset-top)) 1rem calc(1.25rem + env(safe-area-inset-bottom));background:var(--paid);color:var(--paid-ink);text-align:center}
.paid p{color:inherit}
.paid .band{position:absolute;top:calc(3.5rem + env(safe-area-inset-top));left:0;right:0;height:1.75rem}
.paid .phead{display:flex;flex-direction:column;align-items:center;gap:.5rem}
.paid .tick{flex:none;width:3.5rem;height:3.5rem;padding:.75rem;border-radius:50%;background:var(--lime);color:var(--on-lime);stroke:currentColor;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.paid .tick{animation:np-done-pop 420ms cubic-bezier(.34,1.56,.64,1) both}
.paid .tick path{stroke-dasharray:1;animation:np-done-draw 420ms ease-out 120ms both}
@keyframes np-done-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes np-done-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.paid .tick,.paid .tick path{animation:none}}
.paid .ptitle{font-size:1.75rem;font-weight:600;line-height:1.1}
.paid .pto{font-size:1.125rem;font-weight:500;line-height:1.2;margin-top:-.25rem;overflow-wrap:anywhere}
.paid .pamount{font-size:clamp(3.5rem,17vw,4rem);font-weight:600;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:proportional-nums}
.paid .pcode{width:100%;max-width:21rem;margin:.375rem 0 .25rem;padding:.625rem 1rem .75rem;border-radius:var(--r);background:var(--cream);color:var(--ink);display:flex;flex-direction:column;align-items:center;gap:.125rem}
.paid .pcode .plabel{font-size:.875rem;font-weight:500}
.paid .pcode b{display:block;font-size:clamp(4.5rem,22vw,6rem);font-weight:700;line-height:1;letter-spacing:.16em;margin-right:-.16em;font-variant-numeric:tabular-nums}
.paid .pcode .phint{font-size:1rem;font-weight:600}
.paid .ptime{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:.1rem .9rem}
.paid .pago{font-size:1.375rem;font-weight:600;line-height:1.1}
.paid .pclock{font-size:1rem;font-weight:600}
.paid [data-lines]{display:flex;flex-direction:column;align-items:center;gap:.375rem}
.paid [data-lines]:empty{display:none}
.paid .pline{display:inline-flex;align-items:center;min-height:2.25rem;padding:.375rem .875rem;border-radius:var(--r-field);background:rgb(0 0 0/.24);font-size:.9375rem;font-weight:500}
.paid .prows{width:100%;max-width:21rem;margin:.125rem 0 0;padding:.125rem .875rem;border-radius:var(--r-tile);background:rgb(0 0 0/.22);text-align:left}
.paid .prows div{display:flex;justify-content:space-between;gap:1rem;padding:.3rem 0;font-size:.875rem}
.paid .prows div+div{border-top:1px solid rgb(244 242 236/.16)}
.paid .prows dt{min-width:0;font-weight:400;overflow-wrap:anywhere}
.paid .prows dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.paid .pnote{font-size:.875rem;font-weight:400}
.paid .pstale{display:none;font-weight:600}
.paid .pfoot .link{color:inherit}
.paid.stale{background:var(--stale);color:var(--fg)}
.paid.stale .band{display:none}
.paid.stale .tick{background:transparent;color:var(--fg);box-shadow:inset 0 0 0 2px currentColor}
.paid.stale .pline,.paid.stale .prows{background:rgb(0 0 0/.2)}
.paid.stale .pstale{display:block}
.paid .pthanks{display:none;font-size:1.375rem;font-weight:600}
.paid.closed>:not(.pthanks):not(.pfoot){display:none}
.paid.closed .pthanks{display:block}
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
 var at=+el.getAttribute('data-at')||0,skew=(+el.getAttribute('data-now')||Date.now())-Date.now(),fresh=+el.getAttribute('data-fresh'),close=+el.getAttribute('data-close')||0,
  ago=el.querySelector('[data-ago]'),clock=el.querySelector('[data-clock]'),title=el.querySelector('[data-title]'),
  stale=el.classList.contains('stale'),lock=null,iv;
 function release(){if(lock){lock.release().catch(function(){});lock=null;}}
 function wake(){if(stale||lock||!navigator.wakeLock||document.visibilityState!=='visible')return;
  navigator.wakeLock.request('screen').then(function(l){if(stale){l.release().catch(function(){});return;}lock=l;l.addEventListener('release',function(){lock=null;});}).catch(function(){});}
 function goStale(){stale=true;el.classList.add('stale');title.textContent=T.alreadyPaidTitle;release();}
 function tick(){var now=Date.now()+skew;
  if(at&&close&&now-at>=close){if(!stale)goStale();el.classList.add('closed');clearInterval(el.npIv);return;}
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
  /** A quién se pagó (el local): «a Sala Aurora», bajo el título. */
  to?: string | null;
  /** Lo pedido («2× Gin tonic · Nachos»): la primera fila lo dice en vez de «Consumo»; sin desglose, con lo pagado. */
  concept?: string | null;
  /** Cómo se pagó, sin dígitos de la tarjeta («Visa · Apple Pay o Google Pay»): la última fila. */
  method?: string | null;
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
  const closed = at !== null && a.now.getTime() - at >= PAID_CLOSE_MS;
  // La marquesina: «Pagado · 23:15» (sin la hora si aún no consta: /s la pone al pagar).
  const bandText = a.authorizedAt ? `${t.paidTitle} · ${formatTime(a.authorizedAt, t)}` : t.paidTitle;
  const lines = (a.lines ?? []).map((l) => `<p class="pline">${escapeHtml(l)}</p>`).join('');
  const given = a.rows ?? [];
  const first: ReadonlyArray<readonly [string, string]> = a.concept ? [[a.concept, given[0]?.[1] ?? a.amount]] : given.slice(0, 1);
  const money = [...first, ...given.slice(1)]
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd class="num">${escapeHtml(v)}</dd></div>`)
    .join('');
  const method = a.method ? `<div><dt>${escapeHtml(t.receipt.method)}</dt><dd>${escapeHtml(a.method)}</dd></div>` : '';
  const rows = money || method ? `<dl class="prows">${money}${method}</dl>` : '';
  return `<section class="paid${fresh ? '' : ' stale'}${closed ? ' closed' : ''}" id="${id}" data-at="${at ?? ''}" data-now="${a.now.getTime()}" data-fresh="${PAID_FRESH_MS}" data-close="${PAID_CLOSE_MS}" aria-labelledby="${id}Title"${a.hidden ? ' hidden' : ''}>
${paidBand(bandText)}
<div class="phead"><svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" pathLength="1"/></svg><h1 class="ptitle" id="${id}Title" data-title aria-live="polite">${escapeHtml(fresh ? t.paidTitle : t.alreadyPaidTitle)}</h1>${a.to ? `<p class="pto">${escapeHtml(t.paidTo(a.to))}</p>` : ''}</div>
<p class="pamount num" data-amount>${escapeHtml(a.amount)}</p>
${a.code ? codePlate(a.code, t) : ''}
<p class="pstale">${escapeHtml(t.notNewPayment)}</p>
<div class="ptime"><p class="pago num" data-ago>${at !== null ? escapeHtml(formatAgo(a.now.getTime() - at, t)) : ''}</p><p class="pclock num" data-clock aria-label="${escapeHtml(t.clockLabel)}">${escapeHtml(formatClock(a.now, t))}</p></div>
${rows}<div data-lines>${lines}</div>
${a.authorizedAt ? `<p class="pnote">${escapeHtml((a.fromBalance ? t.paidFromBalanceAt : t.confirmedAt)(formatTime(a.authorizedAt, t)))}</p>` : ''}
<p class="pthanks" role="status">${escapeHtml(t.paidClosed)}</p>
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
