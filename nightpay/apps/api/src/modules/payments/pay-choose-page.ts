import { MONEY_JS, clientMoney, escapeHtml, jsConfig } from './club-ui';
import type { PayLanguage } from './customer-lang';
import type { PayDevice } from './pay-device';
import { PAY_TEXT, type PayText } from './pay-i18n';
import type { PayRedirect } from './pay-redirect';
import { tipPresetsFor } from './tip';

/**
 * La página de pago (/pay/:token), pensada para el móvil de noche:
 *
 *  1. Arriba, grande, lo que va a pagar (se pone al día con la propina), con
 *     el local, lo pedido, el extracto y la cuenta atrás.
 *  2. Propina: botones grandes (≥ 56 px) en rejilla de dos; el elegido se ve
 *     invertido (crema) y con su ✓ (no solo por el color); «Sin propina» por
 *     defecto; las sugeridas y su tope son los de siempre (tip.ts); «Otra» con
 *     el teclado numérico y su error dicho con palabras.
 *  3. Desglose: Consumo · Comisión del servicio (si la hay, con «¿Qué es?») ·
 *     Propina · TOTAL. El lector de pantalla oye solo el total al cambiarlo.
 *  4. Abajo, pegados al borde: Apple Pay / Google Pay como botón principal
 *     (cuando el móvil lo tiene), la tarjeta como segunda opción y «Pagar con
 *     mi saldo» si se puede. Mientras se abre el pago, el botón lo dice; lo
 *     elegido se guarda (sessionStorage) por si vuelve atrás o hay un error.
 *
 * Sin JS se puede pagar igual (radios y botones de un formulario normal): se
 * ve el importe, las propinas y los botones. El JS va dentro de plantillas de
 * TypeScript: sin barras invertidas.
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

export interface ChooseContext {
  token: string;
  lang: PayLanguage;
  device: PayDevice;
  statementName: string | null;
  now: Date;
}

/** El desglose (Consumo · Comisión del servicio · Propina · TOTAL): /pay y «Recargar» en /w. */
export const BREAKDOWN_CSS = `
.brk{margin:0;padding:.2rem 1rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
.brk>div{display:grid;grid-template-columns:1fr auto;align-items:center;gap:.25rem 1rem;padding:.6rem 0;border-bottom:1px solid var(--line)}
.brk>div:last-child,.brk>div:has(+.tot){border-bottom:0}
.brk dt{color:var(--mute);display:flex;flex-wrap:wrap;align-items:center;gap:.1rem .5rem}
.brk dd{margin:0;font-family:var(--num);font-weight:800;font-variant-numeric:tabular-nums;color:var(--fg);text-align:right}
.brk .why{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .15rem;border:0;background:none;color:var(--fg);font:inherit;font-size:.85rem;font-weight:700;text-decoration:underline;text-underline-offset:.2em;cursor:pointer}
.brk .why:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.brk dd.whytext{grid-column:1/-1;font-family:var(--sys);font-weight:500;font-size:.9rem;color:var(--mute);text-align:left;line-height:1.45;padding:.1rem 0 .2rem}
.brk .tot{padding:.85rem 0 .7rem;border-top:2px solid var(--line-hi)}
.brk .tot dt{color:var(--fg);font-weight:800;text-transform:uppercase;letter-spacing:.08em;font-size:.9rem}
.brk .tot dd{font-size:1.45rem;color:var(--lime)}
`;

export const CHOOSE_CSS = `
.pay{width:100%;max-width:26rem;margin:0 auto;padding:.25rem 1rem 1.25rem;display:flex;flex-direction:column;gap:1.1rem}
.head{display:flex;flex-direction:column;align-items:center;gap:.3rem;text-align:center;padding-top:.25rem}
.venue{color:var(--fg);font-weight:700;font-size:1rem;letter-spacing:.01em}
.concept{color:var(--mute);font-size:.95rem;max-width:22rem}
.head .kick{margin-top:.35rem}
.amount{font-size:clamp(3.1rem,17vw,4.4rem);font-weight:800;letter-spacing:-.035em;line-height:1;color:var(--fg)}
.meta{display:flex;flex-wrap:wrap;justify-content:center;gap:.15rem .9rem;font-size:.85rem;color:var(--dim)}
.meta b{color:var(--mute)}
form{width:100%;display:flex;flex-direction:column;gap:1.1rem}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{width:100%;margin:0 0 .6rem;padding:0;color:var(--fg);font-weight:700;font-size:1.05rem;text-align:center}
.tipgrid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.tipgrid label{display:block;position:relative}
.tipgrid input{position:absolute;opacity:0;width:1px;height:1px}
.tipgrid span{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.05rem;min-height:3.5rem;padding:.45rem 1.9rem;border:1.5px solid var(--line-hi);border-radius:18px;background:var(--surface-2);font-family:var(--num);font-size:1.15rem;font-weight:800;color:var(--fg);cursor:pointer;line-height:1.15;text-align:center;transition:transform .15s var(--ease)}
.tipgrid span.word{font-family:var(--sys);font-size:1.02rem}
.tipgrid small{font-family:var(--sys);font-size:.82rem;font-weight:700;color:var(--mute)}
.tipgrid input:checked+span{border-color:var(--cream);background:var(--cream);color:var(--ink)}
.tipgrid input:checked+span small{color:var(--ink)}
.tipgrid input:checked+span::before{content:'';position:absolute;top:50%;left:.85rem;width:1.15rem;height:1.15rem;margin-top:-.575rem;border-radius:50%;background:var(--ink) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23EFE9DF' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 13l4 4L19 7'/%3E%3C/svg%3E") center/70% no-repeat}
.tipgrid input:focus-visible+span{outline:3px solid var(--fg);outline-offset:3px}
.tipgrid span:active{transform:scale(.97)}
.other{display:flex;flex-direction:column;align-items:center;gap:.4rem;margin-top:.8rem}
.other label{font-weight:700;color:var(--fg)}
.eur{display:flex;align-items:center;gap:.4rem}
.eur input{width:7.5rem;min-height:3.5rem;font-family:var(--num);font-size:1.7rem;font-weight:800;text-align:center;border-radius:16px;border:2px solid var(--line-hi);background:var(--surface-2);color:var(--fg)}
.eur input:focus-visible{outline:3px solid var(--fg);outline-offset:2px;border-color:var(--fg)}
.eur input[aria-invalid=true]{border-color:var(--err)}
.eur span{font-size:1.4rem;font-weight:800}
.other .err{text-align:center}
.tipnote{margin-top:.65rem;font-size:.9rem;color:var(--mute);text-align:center}
${BREAKDOWN_CSS}.warn{border:1px solid rgb(255 176 32/.55);border-radius:18px;background:rgb(255 176 32/.12);padding:.75rem 1rem;color:var(--fg);font-size:.95rem}
.paybar{position:sticky;bottom:0;z-index:5;margin:0 -1rem;padding:.9rem 1rem calc(.75rem + env(safe-area-inset-bottom));background:linear-gradient(to top,var(--bg) 85%,rgb(15 17 18/0))}
.paybar>div{display:flex;flex-direction:column;gap:.5rem;text-align:center}
.paybar .btn{min-height:3.75rem;font-size:1.25rem}
.paybar .alts{display:grid;grid-template-columns:1fr;gap:.5rem}
.paybar .alts.two{grid-template-columns:1fr 1fr}
.paybar .alts .btn{min-height:3.25rem;font-size:.98rem;padding:.55rem .7rem}
.methods{font-size:.85rem;color:var(--mute)}
.nofee{font-size:.85rem;color:var(--mute)}
.btn.busy{cursor:progress}
.btn.busy::before{content:'';flex:none;width:1.1rem;height:1.1rem;border-radius:50%;border:3px solid currentColor;border-right-color:transparent;animation:np-spin .9s linear infinite}
@keyframes np-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.btn.busy::before{animation:none;border-right-color:currentColor;opacity:.6}}
.btn[aria-disabled=true]:not(.busy){opacity:.55}
/* Móviles bajos (360×740 y similares): todo más compacto para que el desglose no quede detrás de los botones; los toques siguen ≥ 48 px. */
@media (max-height:780px){
.pay{gap:.8rem}
.head{gap:.15rem}
.head .kick{margin-top:.15rem}
.amount{font-size:clamp(2.6rem,14vw,3.4rem)}
.meta{font-size:.8rem}
legend{margin-bottom:.45rem;font-size:1rem}
.tipgrid{gap:.5rem}
.tipgrid span{min-height:3.1rem}
.brk>div{padding:.4rem 0}
.brk .tot{padding:.55rem 0 .45rem}
.paybar{padding-top:.6rem}
.paybar>div{gap:.35rem}
.paybar .btn{min-height:3.4rem;font-size:1.15rem}
.paybar .alts .btn{min-height:3rem}
.methods,.nofee{font-size:.8rem}
}
.secure{display:flex;align-items:center;justify-content:center;gap:.4rem;font-size:.85rem;color:var(--dim)}
.secure svg{width:1rem;height:1rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
`;

export const LOCK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/**
 * Lo puro del JS de la propina (se prueba aparte: tip-choice.spec.ts):
 *  - npTipOther(texto, máximo): la propina de «Otra» en euros enteros, o su
 *    error ('empty': sin importe; 'max': por encima del tope).
 *  - npPayTotal(importe, comisión, propina): lo que paga.
 */
export const TIP_JS = `
function npTipOther(raw,max){var d=String(raw==null?'':raw).split('').filter(function(c){return c>='0'&&c<='9';}).join('');
 if(!d)return {cents:0,error:'empty'};var e=parseInt(d,10);
 if(!(e>0))return {cents:0,error:'empty'};if(e*100>max)return {cents:0,error:'max'};return {cents:e*100,error:null};}
function npPayTotal(amount,fee,tip){return amount+(fee||0)+(tip||0);}
`;

function money(cents: number, view: ChooseView, t: PayText): string {
  return clientMoney(cents, t.locale, view.currency);
}

function percent(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bps / 10_000);
}

/** «4:58»: lo que le queda al QR (sin JS se queda en lo que había al abrir; con JS, cuenta atrás). */
function remaining(expiresAt: Date, now: Date): string {
  const s = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Lo que paga sin propina: el importe y la «Comisión del servicio» (si la hay). */
function dueCents(view: ChooseView): number {
  return view.amountCents + (view.serviceFeeCents ?? 0);
}

/** La propina ya marcada al abrir: la que pidió el cliente al personal (cobro único), si es una de las de botón. */
function presetTip(view: ChooseView): number {
  return view.presetTipCents && view.tipOptionsCents.includes(view.presetTipCents) ? view.presetTipCents : 0;
}

function tipChoices(view: ChooseView, t: PayText): string {
  const presets = tipPresetsFor(view.amountCents, view.tipPresets);
  const preset = presetTip(view);
  const pct = (p: number): string => (p / 100).toLocaleString(t.locale, { style: 'percent' });
  const options = view.tipOptionsCents
    .filter((c) => c > 0)
    .map((c) => {
      const p = presets.find((x) => x.cents === c)?.percent ?? null;
      const label = p
        ? `${escapeHtml(pct(p))}<small class="num">+${escapeHtml(money(c, view, t))}</small>`
        : `+${escapeHtml(money(c, view, t))}`;
      return `<label><input type="radio" name="tip" value="${c}"${c === preset ? ' checked' : ''}><span class="num">${label}</span></label>`;
    })
    .join('');
  // «Otra» necesita JS: empieza oculta y el JS la enseña.
  const canOther = view.tipMaxCents >= 100;
  const maxText = money(Math.floor(view.tipMaxCents / 100) * 100, view, t);
  return `<fieldset class="tips"><legend>${escapeHtml(t.tipLegend)}</legend><div class="tipgrid">
<label><input type="radio" name="tip" value="0"${preset === 0 ? ' checked' : ''}><span class="word">${escapeHtml(t.noTip)}</span></label>${options}${
    canOther
      ? `<label id="otherOpt" hidden><input type="radio" name="tip" value="0" id="otherRadio"><span class="word">${escapeHtml(t.tipOther)}</span></label>`
      : ''
  }</div>
${
  canOther
    ? `<div class="other" id="otherBox" hidden><label for="otherIn">${escapeHtml(t.tipOtherLabel)}</label>
<div class="eur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" enterkeyhint="done" aria-describedby="otherMax otherErr"><span aria-hidden="true">€</span></div>
<p class="small" id="otherMax">${escapeHtml(t.tipMax(maxText))}</p>
<p class="err" id="otherErr" role="alert" hidden></p></div>`
    : ''
}${view.tipToStaff ? `<p class="tipnote">${escapeHtml(t.tipToStaff)}</p>` : ''}</fieldset>`;
}

/**
 * El desglose: Consumo (o Recarga) · Comisión del servicio con «¿Qué es?» ·
 * Propina · TOTAL. Sin comisión ni propinas no hace falta (el importe de
 * arriba lo dice todo). La explicación sale abierta sin JS; con JS, plegada.
 */
function breakdown(view: ChooseView, t: PayText, withTips: boolean): string {
  const fee = view.serviceFeeCents ?? 0;
  if (fee <= 0 && !withTips) return '';
  const b = t.breakdown;
  const m = (c: number): string => escapeHtml(money(c, view, t));
  const feeRow =
    fee > 0
      ? `<div class="fee"><dt>${escapeHtml(b.serviceFee)}${
          view.serviceFeeBps
            ? ` <button class="why" type="button" id="feeWhyBtn" aria-expanded="true" aria-controls="feeWhy">${escapeHtml(t.feeWhat)}</button>`
            : ''
        }</dt><dd class="num">${m(fee)}</dd>${
          view.serviceFeeBps ? `<dd class="whytext" id="feeWhy">${escapeHtml(t.feeExplain(percent(view.serviceFeeBps, t.locale)))}</dd>` : ''
        }</div>`
      : '';
  const tip = presetTip(view);
  return `<dl class="brk" id="brk">
<div><dt>${escapeHtml(view.topUp ? b.topUp : b.consumption)}</dt><dd class="num">${m(view.amountCents)}</dd></div>
${feeRow}${withTips ? `<div id="brkTip"><dt>${escapeHtml(b.tip)}</dt><dd class="num" id="brkTipV">${m(tip)}</dd></div>` : ''}
<div class="tot"><dt>${escapeHtml(t.total)}</dt><dd class="num" id="total">${m(dueCents(view) + tip)}</dd></div>
</dl>`;
}

/**
 * Los botones de pagar. El principal manda `method`: «wallet» (abre Apple Pay
 * o Google Pay), «card» dentro de Instagram y similares (ahí las carteras no
 * van) o vacío (el banco enseña todo). La tarjeta, segunda opción, es otro
 * botón del mismo formulario (method=card): funciona sin JS.
 */
function payButtons(view: ChooseView, t: PayText, ctx: ChooseContext): string {
  const { inApp, wallet } = ctx.device;
  const method = inApp ? 'card' : wallet ? 'wallet' : '';
  const total = money(dueCents(view) + presetTip(view), view, t);
  const fee = view.serviceFeeCents ?? 0;
  const card = !inApp && wallet ? `<button class="btn alt" id="cardBtn" type="submit" name="method" value="card">${escapeHtml(t.payByCard)}</button>` : '';
  const saldo = view.saldoPayToken
    ? `<a class="btn alt saldo" id="saldoBtn" href="${escapeHtml(`/s/${encodeURIComponent(view.saldoPayToken)}?lang=${ctx.lang}`)}">${escapeHtml(t.payWithSaldo)}</a>`
    : '';
  const alts = card || saldo ? `<div class="alts${card && saldo ? ' two' : ''}">${card}${saldo}</div>` : '';
  return `<div class="paybar"><div>
<button class="btn" id="payBtn" type="submit" name="method" value="${method}">${escapeHtml(`${t.payPrefix} ${total}`)}</button>
<p class="methods" id="methods">${escapeHtml(inApp ? t.methodsCard : wallet ? t.methodsWallet(wallet) : t.methods)}</p>
${alts}${saldo && fee > 0 ? `<p class="nofee">${escapeHtml(t.saldoNoFee)}</p>` : ''}
</div></div>`;
}

/** El JS de la página (la cuenta, «Otra», el desglose, enviar, volver atrás, la cuenta atrás). */
const CHOOSE_JS = `
var C=JSON.parse(CFG),T=C.text,f=document.getElementById('pay'),btn=document.getElementById('payBtn'),tot=document.getElementById('total'),
 big=document.getElementById('big'),live=document.getElementById('live'),other=document.getElementById('otherRadio'),box=document.getElementById('otherBox'),
 inp=document.getElementById('otherIn'),oerr=document.getElementById('otherErr'),sent=false,liveT=0,KEY='np_tip_'+C.token;
function $(id){return document.getElementById(id);}
function money(c){return npMoney(c,C.locale,C.currency);}
function otherState(){return npTipOther(inp?inp.value:'',C.max);}
function chosen(){var r=f.querySelector('input[name=tip]:checked');return r||null;}
function state(){var r=chosen();if(!r)return {tip:0,error:null};if(other&&r===other){var o=otherState();return {tip:o.cents,error:o.error};}return {tip:+r.value||0,error:null};}
function showErr(text){if(!oerr)return;oerr.textContent=text||'';oerr.hidden=!text;$('otherMax').hidden=Boolean(text);if(inp)inp.setAttribute('aria-invalid',text?'true':'false');}
function say(){clearTimeout(liveT);liveT=setTimeout(function(){if(live)live.textContent=T.total+': '+tot.textContent;},350);}
function upd(announce){var s=state(),isOther=other&&other.checked;
 if(box)box.hidden=!isOther;
 if(isOther){other.value=String(s.tip);showErr(s.error==='max'?T.tooHigh:'');}else showErr('');
 var sum=npPayTotal(C.amount,C.fee,s.tip),txt=money(sum);
 if(!sent)btn.textContent=T.pay+' '+txt;if(big)big.textContent=txt;
 var tv=$('brkTipV');if(tv)tv.textContent=money(s.tip);
 if(tot&&tot.textContent!==txt){tot.textContent=txt;if(announce)say();}}
function save(){try{var r=chosen();sessionStorage.setItem(KEY,JSON.stringify({v:r&&r===other?'other':(r?r.value:'0'),o:inp?inp.value:''}));}catch(e){}}
function restore(){try{var s=JSON.parse(sessionStorage.getItem(KEY)||'null');if(!s)return;
 if(s.v==='other'&&other){other.checked=true;inp.value=String(s.o||'').slice(0,4);return;}
 var r=f.querySelector('input[name=tip][value="'+String(+s.v||0)+'"]');if(r&&r!==other)r.checked=true;}catch(e){}}
function busy(b,on){f.querySelectorAll('.paybar .btn').forEach(function(x){if(on)x.setAttribute('aria-disabled','true');else x.removeAttribute('aria-disabled');x.classList.remove('busy');});
 if(on){b.classList.add('busy');b.textContent=b.value===C.xpayValue&&C.xpay?T.openingApp:T.opening;f.setAttribute('aria-busy','true');}
 else{f.removeAttribute('aria-busy');var c=$('cardBtn');if(c)c.textContent=T.card;}}
if(other){$('otherOpt').hidden=false;inp.addEventListener('input',function(){upd(true);});}
var why=$('feeWhyBtn');if(why){$('feeWhy').hidden=true;why.setAttribute('aria-expanded','false');
 why.addEventListener('click',function(){var open=why.getAttribute('aria-expanded')!=='true';why.setAttribute('aria-expanded',String(open));$('feeWhy').hidden=!open;});}
f.addEventListener('change',function(e){upd(true);save();if(other&&e.target===other&&other.checked)inp.focus();});
f.addEventListener('submit',function(e){if(sent){e.preventDefault();return;}var s=state();
 if(s.error){e.preventDefault();showErr(s.error==='max'?T.tooHigh:T.empty);inp.focus();try{box.scrollIntoView({block:'center'});}catch(x){}return;}
 upd(false);save();sent=true;busy(e.submitter||btn,true);
 var s2=$('saldoBtn');if(s2)s2.setAttribute('aria-disabled','true');});
var sb=$('saldoBtn');if(sb)sb.addEventListener('click',function(e){if(sent)e.preventDefault();});
window.addEventListener('pageshow',function(e){if(e.persisted){sent=false;busy(btn,false);var s2=$('saldoBtn');if(s2)s2.removeAttribute('aria-disabled');restore();upd(false);}});
restore();upd(false);
var left=$('left'),d=f.dataset,skew=+d.now-Date.now(),exp=+d.expires,iv;
function tick(){var s=Math.max(0,Math.floor((exp-Date.now()-skew)/1000));left.textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2);if(s<=0){clearInterval(iv);setTimeout(function(){location.reload();},1500);}}
if(left){iv=setInterval(tick,1000);tick();}
`;

export function renderChooseBody(view: ChooseView, ctx: ChooseContext): string {
  const t = PAY_TEXT[ctx.lang];
  const withTips = (view.tipMaxCents ?? 0) > 0;
  const fee = view.serviceFeeCents ?? 0;
  const { inApp, wallet } = ctx.device;
  const action = `/pay/${encodeURIComponent(ctx.token)}`;
  const config = jsConfig({
    token: ctx.token,
    amount: view.amountCents,
    fee,
    currency: view.currency,
    locale: t.locale,
    max: view.tipMaxCents ?? 0,
    // El botón principal abre Apple Pay / Google Pay (su texto mientras se abre).
    xpay: Boolean(wallet && !inApp),
    xpayValue: 'wallet',
    text: {
      pay: t.payPrefix,
      total: t.total,
      opening: t.openingTitle,
      openingApp: wallet ? t.openingWallet(wallet) : t.openingTitle,
      card: t.payByCard,
      // Los errores de «Otra» (solo si hay propinas).
      empty: withTips ? t.tipOtherEmpty : '',
      tooHigh: withTips ? t.tipOtherTooHigh(clientMoney(Math.floor((view.tipMaxCents ?? 0) / 100) * 100, t.locale, view.currency)) : '',
    },
  });
  const start = dueCents(view) + presetTip(view);
  return `<main class="pay">
<header class="head">
${view.venueName ? `<p class="venue">${escapeHtml(view.venueName)}</p>` : ''}
<p class="kick" aria-hidden="true">${escapeHtml(t.totalToPay)}</p>
<h1 class="amount num"><span class="sr">${escapeHtml(t.totalToPay)}: </span><span id="big">${escapeHtml(money(start, view, t))}</span></h1>
${view.concept ? `<p class="concept">${escapeHtml(view.concept)}</p>` : ''}
<p class="meta">${ctx.statementName ? `<span>${escapeHtml(t.statement(ctx.statementName))}</span>` : ''}<span>${escapeHtml(t.expiresIn)} <b class="num" id="left">${escapeHtml(remaining(view.qrExpiresAt, ctx.now))}</b></span></p>
</header>
<form id="pay" method="POST" action="${escapeHtml(action)}" data-expires="${view.qrExpiresAt.getTime()}" data-now="${ctx.now.getTime()}">
<input type="hidden" name="lang" value="${ctx.lang}">
${withTips ? tipChoices(view, t) : '<input type="hidden" name="tip" value="0">'}
${breakdown(view, t, withTips)}
<p class="sr" id="live" aria-live="polite" aria-atomic="true"></p>
${inApp ? `<p class="warn" role="note">${escapeHtml(t.inAppWarning(inApp))}</p>` : ''}
${payButtons(view, t, ctx)}
</form>
<p class="secure">${LOCK_ICON}${escapeHtml(t.secure)}</p>
</main>
<script>
(function(){
${MONEY_JS}
${TIP_JS}
var CFG=${config};
${CHOOSE_JS}
})();
</script>`;
}
