import {
  BANK_CONFIRMING_HINT_AFTER_MS,
  BANK_SLOW_AFTER_MS,
  BANK_STILL_WAITING_AFTER_MS,
} from '@nightpay/contracts';
import { clientMoney, escapeHtml } from './club-ui';
import type { LangHref } from './customer-chrome';
import { customerPage } from './customer-page';
import { LOCK_ICON } from './pay-choose-page';
import { PAY_TEXT, type PayLanguage, type PayText } from './pay-i18n';
import type { PayStatusView } from './pay-status';

/**
 * «Comprobando el pago» (05-ui-ux §4): lo que ve el cliente desde que vuelve
 * del banco (o vuelve a escanear el QR) hasta que el banco contesta.
 *
 *  - Importe, local y concepto; tres pasos (enviado ✓, tu banco lo confirma
 *    ◐ con su reloj, pagado ○) y un texto por fase: hasta 20 s «Confirmando…»
 *    (desde los 8 s, «Suele tardar unos segundos»), hasta 60 s «Tu banco está
 *    tardando un poco», hasta 2:30 «Seguimos esperando» con la cuenta atrás
 *    para reintentar y, pasado ese plazo con el QR vigente, «Tu banco no ha
 *    contestado» con «Intentar otra vez» (y «Pagar con mi saldo» si el cobro
 *    se puede pagar con él). Los tiempos, los de @nightpay/contracts/pay-wait
 *    (los mismos del personal).
 *  - «Enseñar al camarero» (desde los 20 s): una placa crema con importe,
 *    hora del envío y referencia corta. «¿Ves el cargo en tu app del banco?»
 *    (desde los 60 s) con el nombre del extracto.
 *  - Consulta su estado en JSON (/pay/:token/status o /pay/result/status?op=)
 *    a 1, 1, 2, 2, 3 s y luego cada 5 s (también cada 5 s, durante 30 min, si
 *    el banco no lo ha confirmado), con 8 s de plazo por consulta y al volver a la
 *    pestaña; al llegar a un estado final, location.replace() a la página del
 *    servidor (el «Pagado» con su cookie, el aviso o el cobro).
 *  - Sin red, la página no se mueve: franja «Sin conexión» y vuelve a
 *    consultar con el evento `online`. Sin JS: <noscript> con recarga.
 *  - Lector de pantalla: una región aria-live que solo cambia de fase; los
 *    relojes, aria-hidden.
 *
 * Nunca dice «Si al final tu banco cobrara los dos, el local te devuelve uno»
 * (el dueño no se ha comprometido) ni «no se te ha cobrado». Sin barras
 * invertidas en el CSS y el JS (van dentro de plantillas de TypeScript).
 */

export type CheckingMode = 'processing' | 'unconfirmed';

export interface CheckingPageInput {
  mode: CheckingMode;
  view: PayStatusView;
  lang: PayLanguage;
  currency: string;
  /** «2× Gin tonic · Nachos» (el concepto del cobro), si lo hay. */
  concept: string | null;
  /** Referencia corta del cobro (C-0012), si la tiene. */
  ref: string | null;
  /** El nombre con el que sale en el extracto (PAY_STATEMENT_NAME o, si no, REDSYS_MERCHANT_NAME). */
  statementName: string | null;
  /** El estado en JSON (/pay/:token/status o /pay/result/status?op=). */
  statusUrl: string;
  /** La página del servidor a la que se va al llegar a un estado final. */
  finalUrl: string;
  /** «Intentar otra vez»: la página del cobro (/pay/:token). */
  retryHref: string | null;
  /** «Pagar con mi saldo» (/s/:token), solo si el cobro se puede pagar con él. */
  saldoHref: string | null;
  langHref: LangHref;
}

/** Fase de la página: la del personal, más «unconfirmed» (sin confirmación del banco). */
export type CheckingPhase = 'start' | 'slow' | 'still' | 'retry' | 'unconfirmed';

/** Consultas mientras espera: rápido al principio (lo normal es que conteste en segundos). */
export const POLL_DELAYS_MS: readonly number[] = [1_000, 1_000, 2_000, 2_000, 3_000];
export const POLL_EVERY_MS = 5_000;
/** Sin confirmación del banco: cada 5 s (antes 15 s) durante 30 min. */
export const UNCONFIRMED_EVERY_MS = 5_000;
export const UNCONFIRMED_FOR_MS = 30 * 60_000;
/** Plazo de cada consulta. */
export const POLL_TIMEOUT_MS = 8_000;

/** La fase en este momento (servidor y página usan la misma regla). */
export function checkingPhase(mode: CheckingMode, view: Pick<PayStatusView, 'attemptStartedAt' | 'retryAt' | 'qrExpiresAt'>, nowMs: number): CheckingPhase {
  if (mode === 'unconfirmed') return 'unconfirmed';
  const retryAt = view.retryAt ? Date.parse(view.retryAt) : null;
  if (retryAt !== null && nowMs >= retryAt && nowMs < Date.parse(view.qrExpiresAt)) return 'retry';
  const elapsed = view.attemptStartedAt ? nowMs - Date.parse(view.attemptStartedAt) : 0;
  if (elapsed >= BANK_STILL_WAITING_AFTER_MS) return 'still';
  if (elapsed >= BANK_SLOW_AFTER_MS) return 'slow';
  return 'start';
}

/** «0:34». */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** El título y el texto de cada fase. */
function phaseTexts(t: PayText): Record<CheckingPhase, { title: string; body: string }> {
  const c = t.checking;
  return {
    start: { title: c.start, body: c.startBody },
    slow: { title: c.slow, body: c.slowBody },
    still: { title: c.still, body: c.slowBody },
    retry: { title: c.noAnswer, body: c.noAnswerBody },
    unconfirmed: { title: c.unconfirmed, body: c.unconfirmedBody },
  };
}

function timeOf(iso: string | null, t: PayText): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString(t.locale, { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

const CHECKING_CSS = `
.ck{width:100%;max-width:26rem;margin:0 auto;min-height:calc(100vh - 3.5rem);min-height:calc(100svh - 3.5rem);padding:.5rem 1rem 2rem;display:flex;flex-direction:column;gap:1rem}
.ck-head{text-align:center;display:flex;flex-direction:column;gap:.2rem;padding-top:.5rem}
.ck-venue{font-size:1.125rem;font-weight:600;color:var(--fg)}
.ck-amount{font-family:var(--num);font-size:clamp(2.5rem,12vw,3rem);font-weight:600;letter-spacing:-.02em;line-height:1.05;color:var(--fg);font-variant-numeric:proportional-nums}
.ck-concept{font-size:.875rem}
.ck-strip{margin:0;padding:.75rem .875rem;border-radius:var(--r-tile);font-weight:500;color:var(--fg);background:rgb(245 179 66/.1);border:1px solid var(--warn)}
.ck-steps{list-style:none;margin:0;padding:.875rem 1rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);display:flex;flex-direction:column;gap:.75rem}
.ck-steps li{display:flex;align-items:center;gap:.75rem;color:var(--mute);font-weight:400}
.ck-steps li[data-s=done]{color:var(--fg)}
.ck-steps li[data-s=now]{color:var(--fg);font-weight:600}
.ck-ic{flex:none;width:1.5rem;height:1.5rem;border-radius:50%;display:grid;place-items:center;font-size:.875rem;font-weight:600;border:2px solid var(--line-hi);color:var(--mute)}
.ck-steps li[data-s=done] .ck-ic{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.ck-steps li[data-s=now] .ck-ic{border-color:var(--fg);border-top-color:transparent;animation:np-ck-spin 1.2s linear infinite}
.ck-clock{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;font-weight:600;color:var(--fg)}
@keyframes np-ck-spin{to{transform:rotate(360deg)}}
@keyframes np-ck-breathe{from{opacity:.4}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.ck-steps li[data-s=now] .ck-ic{animation:np-ck-breathe 1.6s ease-in-out infinite alternate}}
.ck-msg{text-align:center;display:flex;flex-direction:column;gap:.4rem}
.ck-msg h1{font-size:1.375rem}
.ck-small{margin:0;text-align:center;font-size:.875rem;font-weight:500;color:var(--label)}
.ck-actions{display:flex;flex-direction:column;gap:.5rem}
.ck-more{border:1px solid var(--line);border-radius:var(--r-tile);background:var(--surface)}
.ck-more summary{list-style:none;min-height:3.25rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:0 1rem;font-weight:500;cursor:pointer}
.ck-more summary::-webkit-details-marker{display:none}
.ck-more summary::after{content:'+';font-size:1.25rem;color:var(--mute)}
.ck-more[open] summary::after{content:'−'}
.ck-more summary:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.ck-more > p{padding:0 1rem 1rem}
.ck-plate{margin:0 1rem 1rem;padding:1rem;border-radius:var(--r);background:var(--cream);color:var(--ink);display:flex;flex-direction:column;align-items:center;gap:.35rem;text-align:center}
.ck-plate p{color:inherit}
.ck-plate .ck-plate-amount{font-family:var(--num);font-size:clamp(2.5rem,12vw,3rem);font-weight:600;line-height:1;font-variant-numeric:proportional-nums}
.ck-plate dl{display:flex;gap:1.5rem;margin:.25rem 0 0}
.ck-plate dt{font-size:.875rem;font-weight:500}
.ck-plate dd{margin:0;font-family:var(--num);font-size:1.375rem;font-weight:700;letter-spacing:.06em}
.ck-plate .ck-plate-hint{font-size:.9375rem;font-weight:600}
.secure{display:flex;align-items:center;justify-content:center;gap:.4rem}
.secure svg{width:1rem;height:1rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
`;

/** La página. Lo que se pinta ya es la fase de ahora (sin JS se ve bien y se recarga sola). */
export function renderCheckingPage(i: CheckingPageInput, now: Date = new Date()): string {
  const t = PAY_TEXT[i.lang];
  const c = t.checking;
  const texts = phaseTexts(t);
  const nowMs = now.getTime();
  const phase = checkingPhase(i.mode, i.view, nowMs);
  const elapsed = i.view.attemptStartedAt ? Math.max(0, nowMs - Date.parse(i.view.attemptStartedAt)) : 0;
  const amount = clientMoney(i.view.amountCents, t.locale, i.currency);
  const sentAt = timeOf(i.view.attemptStartedAt, t);
  const retryAt = i.view.retryAt ? Date.parse(i.view.retryAt) : null;
  const showsRetryIn = phase === 'still' && retryAt !== null;
  const hidden = (visible: boolean) => (visible ? '' : ' hidden');
  const bankText = i.statementName ? c.bankApp(i.statementName, amount) : c.bankAppNoName(amount);

  const config = {
    mode: i.mode,
    statusUrl: i.statusUrl,
    finalUrl: i.finalUrl,
    now: i.view.now,
    attemptAt: i.view.attemptStartedAt,
    retryAt: i.view.retryAt,
    qrExpiresAt: i.view.qrExpiresAt,
    hintMs: BANK_CONFIRMING_HINT_AFTER_MS,
    slowMs: BANK_SLOW_AFTER_MS,
    stillMs: BANK_STILL_WAITING_AFTER_MS,
    delays: POLL_DELAYS_MS,
    everyMs: POLL_EVERY_MS,
    unconfirmedEveryMs: UNCONFIRMED_EVERY_MS,
    unconfirmedForMs: UNCONFIRMED_FOR_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    saldo: Boolean(i.saldoHref),
    retry: Boolean(i.retryHref),
    t: { ...texts, retryIn: c.retryIn('{t}'), stopped: c.unconfirmedStopped },
  };

  const steps = c.steps
    .map((label, n) => {
      const state = n === 0 ? 'done' : n === 1 ? 'now' : 'next';
      const icon = n === 0 ? '✓' : n === 1 ? '' : '';
      const clockSpan =
        n === 1 && i.mode === 'processing'
          ? `<span class="ck-clock num" id="ckClock" aria-hidden="true">${clock(elapsed)}</span>`
          : '';
      return `<li data-s="${state}"><span class="ck-ic" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span>${clockSpan}</li>`;
    })
    .join('');

  const body = `<main class="ck" data-mode="${i.mode}" data-phase="${phase}" id="ck">
<header class="ck-head">
${i.view.venueName ? `<p class="ck-venue">${escapeHtml(i.view.venueName)}</p>` : ''}
<p class="ck-amount num">${escapeHtml(amount)}</p>
${i.concept ? `<p class="ck-concept">${escapeHtml(i.concept)}</p>` : ''}
</header>
<p class="ck-strip" id="ckOffline" role="status" hidden>${escapeHtml(c.offline)}</p>
<p class="ck-strip" id="ckOther"${hidden(i.view.otherPayer)}>${escapeHtml(c.otherPayer)}</p>
<ol class="ck-steps">${steps}</ol>
<div class="ck-msg" id="ckLive" aria-live="polite">
<h1 id="ckTitle">${escapeHtml(texts[phase].title)}</h1>
<p id="ckBody"${hidden(phase !== 'start' || elapsed >= BANK_CONFIRMING_HINT_AFTER_MS)}>${escapeHtml(texts[phase].body)}</p>
</div>
<p class="ck-small" id="ckRetryIn"${hidden(showsRetryIn)}>${showsRetryIn && retryAt !== null ? escapeHtml(c.retryIn(clock(retryAt - nowMs))) : ''}</p>
<p class="ck-small" id="ckStopped" hidden>${escapeHtml(c.unconfirmedStopped)}</p>
<div class="ck-actions">
${i.retryHref ? `<a class="btn" id="ckRetry" href="${escapeHtml(i.retryHref)}"${hidden(phase === 'retry')}>${escapeHtml(c.retry)}</a>` : ''}
${i.saldoHref ? `<a class="btn alt" id="ckSaldo" href="${escapeHtml(i.saldoHref)}"${hidden(phase === 'retry')}>${escapeHtml(t.payWithSaldo)}</a>` : ''}
<details class="ck-more" id="ckShow"${hidden(phase !== 'start')}>
<summary>${escapeHtml(c.showStaff)}</summary>
<div class="ck-plate" role="group" aria-label="${escapeHtml(c.showStaff)}">
<p class="ck-plate-amount num">${escapeHtml(amount)}</p>
${i.ref ? `<dl><div><dt>${escapeHtml(c.reference)}</dt><dd>${escapeHtml(i.ref)}</dd></div></dl>` : ''}
${sentAt ? `<p>${escapeHtml(c.sentAt(sentAt))}</p>` : ''}
<p class="ck-plate-hint">${escapeHtml(c.plateHint)}</p>
</div>
</details>
<details class="ck-more" id="ckBank"${hidden(phase === 'still' || phase === 'retry' || phase === 'unconfirmed')}>
<summary>${escapeHtml(c.bankAppTitle)}</summary>
<p>${escapeHtml(bankText)}</p>
</details>
</div>
<p class="foot secure">${LOCK_ICON}${escapeHtml(t.secure)}</p>
</main>
<script type="application/json" id="ckCfg">${jsConfigJson(config)}</script>
<script>${CHECKING_JS}</script>`;

  // Sin JS, la misma página se recarga sola (cada 5 s; sin confirmación, cada UNCONFIRMED_EVERY_MS).
  const refresh = i.mode === 'unconfirmed' ? Math.round(UNCONFIRMED_EVERY_MS / 1000) : 5;
  const head = `<noscript><meta http-equiv="refresh" content="${refresh};url=${escapeHtml(i.finalUrl)}"></noscript><style>${CHECKING_CSS}</style>`;
  // La pestaña siempre dice qué es («Comprobando el pago»); la fase, en la página.
  return customerPage(t, t.processingTitle, body, { head, layout: 'bare', langHref: i.langHref });
}

/** «<» como su escape JSON (la barra invertida, con su código: este fichero no lleva barras sueltas). */
const ESCAPED_LT = `${String.fromCharCode(92)}u003c`;

/** El objeto para el <script type=application/json>: el JSON con «<» escapado (no puede cerrar la etiqueta). */
function jsConfigJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, ESCAPED_LT);
}

/**
 * El JS de la página (ES5, sin barras invertidas: va dentro de una plantilla).
 * Lee la configuración, pinta la fase cada segundo y consulta el estado.
 */
export const CHECKING_JS = `(function(){
var C;try{C=JSON.parse(document.getElementById('ckCfg').textContent);}catch(e){return;}
var off=Date.parse(C.now)-Date.now(),mode=C.mode,attempt=C.attemptAt?Date.parse(C.attemptAt):null,retryAt=C.retryAt?Date.parse(C.retryAt):null,qrEnd=Date.parse(C.qrExpiresAt);
var loaded=Date.now(),phase=null,timer=null,ctrl=null,step=0,gone=false,stopped=false;
function el(id){return document.getElementById(id);}
function show(id,on){var e=el(id);if(e)e.hidden=!on;}
function sNow(){return Date.now()+off;}
function clock(ms){var s=Math.max(0,Math.floor(ms/1000)),r=s%60;return Math.floor(s/60)+':'+(r<10?'0':'')+r;}
function phaseNow(){
 if(mode==='unconfirmed')return 'unconfirmed';
 var n=sNow(),e=attempt===null?0:n-attempt;
 if(retryAt!==null&&n>=retryAt&&n<qrEnd)return 'retry';
 if(e>=C.stillMs)return 'still';
 if(e>=C.slowMs)return 'slow';
 return 'start';
}
function render(){
 var p=phaseNow(),n=sNow(),e=attempt===null?0:Math.max(0,n-attempt);
 if(p!==phase){
  phase=p;el('ck').setAttribute('data-phase',p);
  el('ckTitle').textContent=C.t[p].title;el('ckBody').textContent=C.t[p].body;
  show('ckShow',p!=='start');show('ckBank',p==='still'||p==='retry'||p==='unconfirmed');
  show('ckRetry',p==='retry');show('ckSaldo',p==='retry'&&C.saldo);
 }
 show('ckBody',p!=='start'||e>=C.hintMs);
 var k=el('ckClock');if(k)k.textContent=clock(e);
 var ri=el('ckRetryIn');
 if(ri){if(p==='still'&&retryAt!==null){ri.hidden=false;ri.textContent=C.t.retryIn.split('{t}').join(clock(retryAt-n));}else{ri.hidden=true;}}
}
function go(){if(gone)return;gone=true;clearTimeout(timer);location.replace(C.finalUrl);}
function schedule(ms){clearTimeout(timer);if(!gone&&!stopped)timer=setTimeout(poll,ms);}
function nextDelay(){if(mode==='unconfirmed')return C.unconfirmedEveryMs;var d=step<C.delays.length?C.delays[step]:C.everyMs;step++;return d;}
function apply(s){
 if(s.attemptStartedAt)attempt=Date.parse(s.attemptStartedAt);
 retryAt=s.retryAt?Date.parse(s.retryAt):null;
 if(s.qrExpiresAt)qrEnd=Date.parse(s.qrExpiresAt);
 if(s.now)off=Date.parse(s.now)-Date.now();
 show('ckOther',!!s.otherPayer);
 var keep=mode==='unconfirmed'?(s.state==='unconfirmed'||s.state==='processing'):s.state==='processing';
 if(!keep){go();return;}
 render();schedule(nextDelay());
}
function poll(){
 if(gone||stopped)return;
 if(mode==='unconfirmed'&&Date.now()-loaded>C.unconfirmedForMs){stopped=true;show('ckStopped',true);return;}
 if(ctrl){try{ctrl.abort();}catch(x){}}
 var mine=typeof AbortController==='function'?new AbortController():null;ctrl=mine;
 var kill=setTimeout(function(){if(mine)mine.abort();},C.timeoutMs);
 fetch(C.statusUrl,{cache:'no-store',credentials:'same-origin',headers:{'Accept':'application/json'},signal:mine?mine.signal:undefined})
 .then(function(r){
  clearTimeout(kill);
  if(r.status===429){var ra=Number(r.headers.get('Retry-After'))||5;return {wait:Math.min(30,Math.max(5,ra))*1000};}
  if(r.status===404)return {state:'gone'};
  if(!r.ok)return {wait:5000};
  return r.json();
 })
 .then(function(s){
  if(ctrl===mine)ctrl=null;
  show('ckOffline',false);
  if(s.wait){schedule(s.wait);return;}
  if(s.state==='gone'){go();return;}
  apply(s);
 })
 .catch(function(){
  clearTimeout(kill);if(ctrl===mine)ctrl=null;
  show('ckOffline',true);
  schedule(navigator.onLine===false?30000:5000);
 });
}
window.addEventListener('online',function(){show('ckOffline',false);step=0;poll();});
window.addEventListener('offline',function(){show('ckOffline',true);});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'){step=0;poll();}});
window.addEventListener('pageshow',function(e){if(e.persisted){step=0;poll();}});
render();setInterval(render,1000);schedule(nextDelay());
})();`;
