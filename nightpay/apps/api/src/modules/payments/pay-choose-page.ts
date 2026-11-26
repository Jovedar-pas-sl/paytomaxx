import { MONEY_JS, clientMoney, escapeHtml, jsConfig } from './club-ui';
import type { LangHref } from './customer-chrome';
import type { PayLanguage } from './customer-lang';
import type { PayDevice } from './pay-device';
import { CUSTOMER_TEXT } from './i18n';
import { PAY_TEXT, type PayText } from './pay-i18n';
import { BTC_MARK, CARD_IC, GPAY_MARK, LOCK_IC, PAY_MARKS_CSS, trustLine } from './pay-marks';
import type { PayRedirect } from './pay-redirect';
import { TIP_BUTTONS_CSS, TIP_BUTTONS_LOW_CSS, tipButtons } from './tip-buttons';
import { legalConsent } from '../legal/legal-links';

/**
 * La página de pago (/pay/:token), pensada para el móvil de noche:
 *
 *  1. Arriba, grande, lo que va a pagar (se pone al día con la propina), con
 *     el local, lo pedido, el extracto y la cuenta atrás.
 *  2. Propina (tip-buttons.ts, los mismos botones que en /s): cada uno con
 *     sus euros y, debajo, el total con ella; el elegido se ve invertido y con
 *     su ✓ (no solo por el color). Sin nada marcado (B1: la elige el cliente;
 *     sin elegir, no hay propina); las sugeridas y su tope son los de siempre
 *     (tip.ts); «Otra» con el teclado numérico y su error dicho con palabras.
 *     Debajo, a quién va.
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
  /** El idioma que se le ofrece en la franja de arriba (idea 71); null o sin él, sin franja. */
  suggest?: PayLanguage | null;
  /** Los enlaces de idioma de esta página, si llevan algo más que ?lang= (la propina de ?tip=). */
  langHref?: LangHref;
}

/**
 * Cuando ni con lo de las pantallas bajas cabe (hay desglose a la vista al
 * abrir: comisión, o una propina ya marcada), hasta 900 px de alto: la franja
 * que ofrece otro idioma baja debajo del formulario (como en las bajas) y Visa
 * y Mastercard siguen a la frase del banco en su misma línea (la barra de
 * pagar mide una línea menos y no tapa los botones de la propina). Lo decide
 * el servidor (chooseCss): el CSS no sabe si cabe.
 */
export const CROWDED_CSS =
  '@media (max-height:900px){body{display:flex;flex-direction:column}.sug{order:1}.legal-foot{order:2}.trust .marks{display:inline-flex;margin:0 0 0 .4rem;vertical-align:middle}}';

/** El desglose (Consumo · Comisión del servicio · Propina · TOTAL): /pay y «Recargar» en /w. */
export const BREAKDOWN_CSS = `
.brk{margin:0;padding:.2rem 1rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
.brk>div{display:grid;grid-template-columns:1fr auto;align-items:center;gap:.25rem 1rem;padding:.6rem 0;border-bottom:1px solid var(--line)}
.brk>div:last-child,.brk>div:has(+.tot){border-bottom:0}
.brk dt{color:var(--mute);display:flex;flex-wrap:wrap;align-items:center;gap:.1rem .5rem}
.brk dd{margin:0;font-family:var(--num);font-weight:600;font-variant-numeric:tabular-nums;color:var(--fg);text-align:right}
.brk .why{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .15rem;border:0;background:none;color:var(--fg);font:inherit;font-size:.875rem;font-weight:500;text-decoration:underline;text-underline-offset:.2em;cursor:pointer}
.brk .why:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.brk dd.whytext{grid-column:1/-1;font-family:var(--sans);font-weight:400;font-size:.875rem;color:var(--mute);text-align:left;line-height:1.45;padding:.1rem 0 .2rem}
.brk .tot{padding:.75rem 0 .625rem;border-top:1px solid var(--line-hi)}
.brk .tot dt{color:var(--fg);font-weight:600;font-size:1rem}
.brk .tot dd{font-size:1.125rem;color:var(--fg)}
`;

/**
 * El último minuto de un cobro (idea 65), en /pay y en /s: con 60 s o menos, la
 * cuenta atrás pasa a un aviso en ámbar (14/600, con un reloj de trazo). Lo
 * pinta el servidor si la página se abre así y el JS al llegar; el lector de
 * pantalla lo oye una vez.
 */
export const LAST_MINUTE_S = 60;

export const SOON_CSS = `.soon{color:var(--warn);font-family:var(--sans);font-size:.875rem;font-weight:600;line-height:1.35;font-variant-numeric:tabular-nums}
.soon::before{content:'';display:inline-block;width:1.1em;height:1.1em;margin-right:.35rem;vertical-align:-.18em;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f5b342' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7v5l3 2'/%3E%3C/svg%3E") center/contain no-repeat}
`;

export const CHOOSE_CSS = `
.pay{width:100%;max-width:26rem;margin:0 auto;padding:.25rem 1rem 1.25rem;display:flex;flex-direction:column;gap:1.1rem}
.head{display:flex;flex-direction:column;align-items:center;gap:.3rem;text-align:center;padding-top:.25rem}
.venue{color:var(--fg);font-weight:600;font-size:1.125rem}
.concept{color:var(--mute);font-size:.875rem;max-width:22rem}
.who{display:flex;align-items:center;gap:.5rem;color:var(--mute);font-size:.875rem}
.who .face{width:2rem;height:2rem;border-radius:50%;object-fit:cover;flex:none}
.head .kick{margin-top:.35rem}
.amount{font-size:clamp(2.5rem,12vw,3rem);font-weight:600;letter-spacing:-.02em;line-height:1.05;color:var(--fg);font-variant-numeric:proportional-nums}
.meta{display:flex;flex-wrap:wrap;justify-content:center;gap:.15rem .9rem;font-size:.875rem;color:var(--dim)}
.meta b{color:var(--mute);font-weight:600}
form{width:100%;display:flex;flex-direction:column;gap:1.1rem}${TIP_BUTTONS_CSS}${BREAKDOWN_CSS}.warn{border:1px solid var(--warn);border-radius:var(--r-tile);background:rgb(245 179 66/.1);padding:.75rem 1rem;color:var(--fg);font-size:.875rem}
.paybar{position:sticky;bottom:0;z-index:5;margin:0 -1rem;padding:.6rem 1rem calc(.7rem + env(safe-area-inset-bottom));background:var(--bg)}
.paybar::before{content:'';position:absolute;left:0;right:0;bottom:100%;height:.75rem;background:linear-gradient(to top,var(--bg),rgb(9 21 24/0));pointer-events:none}
.paybar>div{display:flex;flex-direction:column;gap:.5rem;text-align:center}
.paybar .btn{min-height:3.5rem;font-size:1.0625rem}
.paybar .alts{display:grid;grid-template-columns:1fr;gap:.5rem}
.paybar .alts .btn{min-height:3rem;font-size:.9375rem;padding:.55rem .7rem}
.methods{font-size:.875rem;color:var(--mute)}
.btn.btc{background:#fff;border-color:#fff;color:#000;box-shadow:0 1px 2px rgba(0,0,0,.35);gap:.35rem;font-weight:500}
.btn.btc .btcmark{display:block;width:1.45rem;height:1.45rem;flex:none}
.btn.btc .btcword{font-family:var(--num);font-weight:700;font-size:1.0625rem;letter-spacing:-.01em}
.btchint{font-size:.875rem;line-height:1.3;color:var(--mute)}
.nofee{font-size:.875rem;color:var(--mute)}
.keep{margin:.75rem 0 0;font-size:.875rem;line-height:1.4;color:var(--label);text-align:center}
.btn.gpay[aria-disabled=true]:not(.busy){opacity:.55}
.btn.gpay{background:#fff;border-color:#fff;color:#1f1f1f;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.btn.gpay .gmark{display:block;width:auto;height:1.55rem}
@supports (-webkit-appearance:-apple-pay-button){
.btn.apay{-webkit-appearance:-apple-pay-button;-apple-pay-button-type:plain;-apple-pay-button-style:white;height:3.5rem;padding:0;border:0;border-radius:999px;box-shadow:none;filter:none}
.btn.apay>*{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
}
.or{display:flex;align-items:center;gap:.75rem;font-size:.875rem;line-height:1;color:var(--dim)}
.or::before,.or::after{content:'';flex:1;height:1px;background:var(--line)}
${PAY_MARKS_CSS}${SOON_CSS}/* Móviles bajos (360×740 y similares): todo más compacto para que el desglose no quede detrás de los botones; los toques siguen ≥ 48 px. Sin la «o» de adorno y, con tarjeta y saldo, los dos secundarios lado a lado: la barra deja sitio al TOTAL. Lo que se aparta, por orden, para que el TOTAL quede por encima de la barra: lo pedido en una línea y, sin comisión ni propina marcada, sin desglose (el total ya es el importe grande), las dos hasta 900 px de alto (medido: en 390×844 tampoco cabía); la franja de idioma, debajo del formulario; y, si ni así cabe, CROWDED_CSS. Nunca se esconden la comisión, el total, el extracto, la caducidad ni la frase del banco. */
@media (max-height:780px){
body{display:flex;flex-direction:column}
.sug{order:1}
.legal-foot{order:2}
.top{min-height:3.25rem;padding-top:calc(.25rem + env(safe-area-inset-top));padding-bottom:.25rem}
.pay{gap:.8rem}
form{gap:.8rem}
.head{gap:.15rem}
.head .kick{margin-top:.15rem}
.who .face{width:1.5rem;height:1.5rem}
.amount{font-size:2.5rem}${TIP_BUTTONS_LOW_CSS}.brk>div{padding:.4rem 0}
.brk .tot{padding:.55rem 0 .45rem}
.brk dt{font-size:.875rem}
.brk dd{font-size:.9375rem}
.brk .tot dd{font-size:1.0625rem}
.paybar{padding-top:.45rem}
.paybar>div{gap:.3rem}
.paybar .btn{min-height:3.25rem;font-size:1.0625rem}
.paybar .btn.apay{height:3.25rem}
.paybar .alts .btn{min-height:3rem;padding:.5rem;line-height:1.15}
.paybar .or{display:none}
.paybar .alts:has(>.btn+.btn){grid-template-columns:1fr 1fr}
.paybar .alts:has(>.btn+.btn) .btn.btc .btcpre{display:none}
.paybar .alts:has(>.btn+.btn)+.btchint{display:none}
}
@media (max-height:900px){
.concept{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brk.nil{display:none}
}
.secure{display:flex;align-items:center;justify-content:center;gap:.4rem;font-size:.875rem;color:var(--dim)}
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

/** «5 €» en las propinas; con `full`, «56,00 €»: lo que se cobra (arriba, el desglose y el botón) va con céntimos. */
function money(cents: number, view: ChooseView, t: PayText, full = false): string {
  return clientMoney(cents, t.locale, view.currency, full);
}

function percent(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bps / 10_000);
}

/** Los segundos que le quedan al cobro (nunca menos de 0). */
export function secondsLeft(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}

/** «4:58» (sin JS se queda en lo que había al abrir; con JS, cuenta atrás). */
export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Lo que paga sin propina: el importe y la «Comisión del servicio» (si la hay). */
function dueCents(view: ChooseView): number {
  return view.amountCents + (view.serviceFeeCents ?? 0);
}

/** La propina ya marcada al abrir: la que pidió el cliente al personal (cobro único), si es una de las de botón. */
function presetTip(view: ChooseView): number {
  return view.presetTipCents && view.tipOptionsCents.includes(view.presetTipCents) ? view.presetTipCents : 0;
}

/** El CSS de la página de este cobro: el de siempre y, con desglose a la vista al abrir (no cabe), CROWDED_CSS. */
export function chooseCss(view: ChooseView): string {
  return (view.serviceFeeCents ?? 0) > 0 || presetTip(view) > 0 ? `${CHOOSE_CSS}${CROWDED_CSS}` : CHOOSE_CSS;
}

/**
 * Las propinas (tip-buttons.ts): cada botón enseña el total con la comisión del
 * servicio dentro. Nada marcado salvo la que ya traía (cobro único o la
 * pantalla de la barra). «Otra» necesita JS: empieza oculta y el JS la enseña.
 */
function tipChoices(view: ChooseView, t: PayText): string {
  const preset = presetTip(view);
  return tipButtons({
    t,
    currency: view.currency,
    dueCents: dueCents(view),
    tipsCents: view.tipOptionsCents.filter((c) => c > 0),
    maxCents: view.tipMaxCents,
    checkedCents: preset > 0 ? preset : null,
    otherHidden: true,
    toStaff: view.tipToStaff === true,
  });
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
  const m = (c: number): string => escapeHtml(money(c, view, t, true));
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
  // Sin comisión ni propina marcada, el desglose no dice nada que no diga el importe grande: en pantallas bajas se aparta (.nil).
  return `<dl class="brk${fee <= 0 && tip <= 0 ? ' nil' : ''}" id="brk">
<div><dt>${escapeHtml(view.topUp ? b.topUp : b.consumption)}</dt><dd class="num">${m(view.amountCents)}</dd></div>
${feeRow}${withTips ? `<div id="brkTip"><dt>${escapeHtml(b.tip)}</dt><dd class="num" id="brkTipV">${m(tip)}</dd></div>` : ''}
<div class="tot"><dt>${escapeHtml(t.total)}</dt><dd class="num" id="total">${m(dueCents(view) + tip)}</dd></div>
</dl>`;
}

/**
 * Los botones de pagar, como en una página de pago. El principal manda
 * `method`: «wallet» (abre Apple Pay o Google Pay), «card» dentro de
 * Instagram y similares (ahí las carteras no van) o vacío (el banco enseña
 * todo). Con «wallet», en Android es el botón claro de Google Pay (pay-marks);
 * en el iPhone sale «🔒 Pagar 56,00 €» y el JS lo cambia por el botón de
 * Apple Pay que pinta Safari, solo si el móvil puede pagar con Apple Pay
 * (ApplePaySession): nunca uno hecho a mano. La tarjeta, segunda opción, es
 * otro botón del mismo formulario (method=card): funciona sin JS. Debajo,
 * dónde se escribe la tarjeta (idea 63), con Visa y Mastercard.
 */
function payButtons(view: ChooseView, t: PayText, ctx: ChooseContext): string {
  const { inApp, wallet } = ctx.device;
  const method = inApp ? 'card' : wallet ? 'wallet' : '';
  const label = `${t.payPrefix} ${money(dueCents(view) + presetTip(view), view, t, true)}`;
  const fee = view.serviceFeeCents ?? 0;
  const gpay = method === 'wallet' && wallet === 'Google Pay';
  const main = gpay
    ? `<button class="btn gpay" id="payBtn" type="submit" name="method" value="${method}"><span class="lbl sr">${escapeHtml(`${label}. ${t.methodsWallet(wallet)}`)}</span>${GPAY_MARK}</button>`
    : `<button class="btn" id="payBtn" type="submit" name="method" value="${method}">${LOCK_IC}<span class="lbl">${escapeHtml(label)}</span></button>`;
  // Con el botón de Google Pay ya se ve con qué se paga.
  const methods = gpay
    ? ''
    : `<p class="methods" id="methods">${escapeHtml(inApp ? t.methodsCard : wallet ? t.methodsWallet(wallet) : t.methods)}</p>`;
  const card =
    !inApp && wallet
      ? `<button class="btn alt" id="cardBtn" type="submit" name="method" value="card">${CARD_IC}<span>${escapeHtml(t.payByCard)}</span></button>`
      : '';
  const saldo = view.saldoPayToken
    ? `<a class="btn alt saldo" id="saldoBtn" href="${escapeHtml(`/s/${encodeURIComponent(view.saldoPayToken)}?lang=${ctx.lang}`)}">${escapeHtml(t.payWithSaldo)}</a>`
    : '';
  // «Pagar con bitcoin»: otro botón del mismo formulario que va a su propia página (formaction),
  // con su icono y una línea corta de cuánto tarda (Lightning al momento, en la red con 1 confirmación).
  const bitcoin = view.bitcoin
    ? `<button class="btn btc" id="btcBtn" type="submit" formaction="${escapeHtml(`/pay/${encodeURIComponent(ctx.token)}/bitcoin?lang=${ctx.lang}`)}" formmethod="post" aria-label="${escapeHtml(t.payWithBitcoin)}"><span class="btcpre">${escapeHtml(t.payWithBitcoinPrefix)}</span>${BTC_MARK}<span class="btcword">bitcoin</span></button>`
    : '';
  const alts =
    card || saldo || bitcoin
      ? `<p class="or" aria-hidden="true">${escapeHtml(t.or)}</p><div class="alts">${card}${bitcoin}${saldo}</div>${bitcoin ? `<p class="btchint">${escapeHtml(t.bitcoinHint)}</p>` : ''}`
      : '';
  return `<div class="paybar"><div>
${main}
${methods}${alts}${saldo && fee > 0 ? `<p class="nofee">${escapeHtml(t.saldoNoFee)}</p>` : ''}
${trustLine(t)}
${legalConsent(ctx.lang)}
</div></div>`;
}

/** El JS de la página (la cuenta, «Otra», el desglose, enviar, volver atrás, la cuenta atrás). */
const CHOOSE_JS = `
var C=JSON.parse(CFG),T=C.text,f=document.getElementById('pay'),btn=document.getElementById('payBtn'),tot=document.getElementById('total'),
 big=document.getElementById('big'),live=document.getElementById('live'),other=document.getElementById('otherRadio'),box=document.getElementById('otherBox'),
 inp=document.getElementById('otherIn'),oerr=document.getElementById('otherErr'),sent=false,liveT=0,KEY='np_tip_'+C.token;
function $(id){return document.getElementById(id);}
function money(c){return npMoney(c,C.locale,C.currency,true);}
function otherState(){return npTipOther(inp?inp.value:'',C.max);}
function chosen(){var r=f.querySelector('input[name=tip]:checked');return r||null;}
function state(){var r=chosen();if(!r)return {tip:0,error:null};if(other&&r===other){var o=otherState();return {tip:o.cents,error:o.error};}return {tip:+r.value||0,error:null};}
function showErr(text){if(!oerr)return;oerr.textContent=text||'';oerr.hidden=!text;$('otherMax').hidden=Boolean(text);if(inp)inp.setAttribute('aria-invalid',text?'true':'false');}
function say(){clearTimeout(liveT);liveT=setTimeout(function(){if(live)live.textContent=T.total+': '+tot.textContent;},350);}
function upd(announce){var s=state(),isOther=other&&other.checked;
 if(box)box.hidden=!isOther;
 if(isOther){other.value=String(s.tip);showErr(s.error==='max'?T.tooHigh:'');}else showErr('');
 var sum=npPayTotal(C.amount,C.fee,s.tip),txt=money(sum);
 if(!sent){var lb=btn.querySelector('.lbl');if(lb)lb.textContent=T.pay+' '+txt+(C.hint?'. '+C.hint:'');}if(big)big.textContent=txt;
 var tv=$('brkTipV');if(tv)tv.textContent=money(s.tip);
 var bk=$('brk');if(bk)bk.classList.toggle('nil',!(C.fee>0||s.tip>0));
 if(tot&&tot.textContent!==txt){tot.textContent=txt;if(announce)say();}}
function reveal(){var b=$('brk'),bar=f.querySelector('.paybar');if(!b||!bar)return;
 var gap=b.getBoundingClientRect().bottom-(bar.getBoundingClientRect().top-16);
 if(gap>0){try{window.scrollBy({top:gap,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}catch(x){window.scrollBy(0,gap);}}}
function save(){try{var r=chosen();sessionStorage.setItem(KEY,JSON.stringify({v:r&&r===other?'other':(r?r.value:'0'),o:inp?inp.value:''}));}catch(e){}}
function restore(){try{var s=JSON.parse(sessionStorage.getItem(KEY)||'null');if(!s)return;
 if(s.v==='other'&&other){other.checked=true;inp.value=String(s.o||'').slice(0,4);return;}
 var r=f.querySelector('input[name=tip][value="'+String(+s.v||0)+'"]');if(r&&r!==other)r.checked=true;}catch(e){}}
var orig={};f.querySelectorAll('.paybar .btn').forEach(function(x){if(x.id)orig[x.id]=x.innerHTML;});
function busy(b,on){f.querySelectorAll('.paybar .btn').forEach(function(x){if(on)x.setAttribute('aria-disabled','true');
 else{x.removeAttribute('aria-disabled');if(x.id&&orig[x.id]!=null)x.innerHTML=orig[x.id];}x.classList.remove('busy');});
 if(on){b.classList.remove('apay');b.classList.add('busy');b.textContent=b.value===C.xpayValue&&C.xpay?T.openingApp:T.opening;f.setAttribute('aria-busy','true');}
 else{f.removeAttribute('aria-busy');applePay();}}
function applePay(){if(C.wallet!=='apple')return;
 try{if(window.ApplePaySession&&ApplePaySession.canMakePayments()&&window.CSS&&CSS.supports('-webkit-appearance','-apple-pay-button')){btn.classList.add('apay');
  var m=$('methods');if(m){C.hint=m.textContent;m.hidden=true;}upd(false);}}catch(e){}}
if(other){$('otherOpt').hidden=false;inp.addEventListener('input',function(){upd(true);});
 inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();inp.blur();}});
 inp.addEventListener('change',reveal);}
var why=$('feeWhyBtn');if(why){$('feeWhy').hidden=true;why.setAttribute('aria-expanded','false');
 why.addEventListener('click',function(){var open=why.getAttribute('aria-expanded')!=='true';why.setAttribute('aria-expanded',String(open));$('feeWhy').hidden=!open;});}
f.addEventListener('change',function(e){upd(true);save();if(other&&e.target===other&&other.checked)inp.focus();});
f.addEventListener('submit',function(e){if(sent){e.preventDefault();return;}var s=state();
 if(s.error){e.preventDefault();showErr(s.error==='max'?T.tooHigh:T.empty);inp.focus();try{box.scrollIntoView({block:'center'});}catch(x){}return;}
 upd(false);save();sent=true;busy(e.submitter||btn,true);
 var s2=$('saldoBtn');if(s2)s2.setAttribute('aria-disabled','true');});
// «Pagar con mi saldo»: la propina que ya eligió aquí va con él (?tip=) y sale marcada en /s.
var sb=$('saldoBtn');if(sb)sb.addEventListener('click',function(e){if(sent){e.preventDefault();return;}var s=state();
 if(!s.error&&chosen()){try{var u=new URL(sb.getAttribute('href'),location.href);u.searchParams.set('tip',String(s.tip));sb.setAttribute('href',u.pathname+u.search);}catch(x){}}});
window.addEventListener('pageshow',function(e){if(e.persisted){sent=false;busy(btn,false);var s2=$('saldoBtn');if(s2)s2.removeAttribute('aria-disabled');restore();upd(false);}});
restore();upd(false);applePay();
// La cuenta atrás; en el último minuto, el aviso en ámbar (y #live lo dice una vez, al cambiar).
var left=$('left'),soon=$('soon'),d=f.dataset,skew=+d.now-Date.now(),exp=+d.expires,iv;
function tick(){var s=Math.max(0,Math.floor((exp-Date.now()-skew)/1000)),m=Math.floor(s/60)+':'+('0'+s%60).slice(-2);left.textContent=m;
 if(s<=60){soon.textContent=T.soon.split('{time}').join(m);if(soon.hidden){soon.hidden=false;$('exp').hidden=true;if(live)live.textContent=soon.textContent;}}
 if(s<=0){clearInterval(iv);setTimeout(function(){location.reload();},1500);}}
if(left){iv=setInterval(tick,1000);tick();}
`;

/**
 * Una carga de saldo: la regla del dueño (17-nov-2026) antes de pagar, para que
 * nadie cargue pensando que se le devuelve. Un cobro de la barra no la lleva;
 * un reservado tampoco (sus páginas dicen sus reglas).
 */
function keepRuleLine(view: ChooseView, lang: PayLanguage): string {
  if (!view.topUp || view.reservation) return '';
  return `<p class="keep" id="keepRule">${escapeHtml(CUSTOMER_TEXT[lang].wallet.keepRule)}</p>`;
}

/**
 * Quién cobra (decisión del dueño, 19-11-2026), como en /s: su nombre visible
 * y su foto si tiene. La foto es de adorno (el nombre va al lado): alt vacío.
 * A nombre de una compañera (cobro por el encargado): «Servicio con Nerea», con su foto.
 */
function whoLine(view: ChooseView, t: PayText): string {
  if (!view.staffName) return '';
  const photo = view.staffPhoto?.startsWith('data:image/')
    ? `<img class="face" src="${escapeHtml(view.staffPhoto)}" alt="" width="32" height="32">`
    : '';
  const who = view.served ? t.serviceWith(view.staffName) : t.chargedBy(view.staffName);
  return `<p class="who">${photo}<span>${escapeHtml(who)}</span></p>`;
}

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
    // Qué cartera es el botón principal: con «apple», el JS pone el de Safari si el móvil puede.
    wallet: wallet && !inApp ? (wallet === 'Apple Pay' ? 'apple' : 'google') : null,
    // El botón de Google Pay no lleva texto a la vista: el importe y la cartera, para el lector de pantalla.
    hint: wallet === 'Google Pay' && !inApp ? t.methodsWallet(wallet) : '',
    text: {
      pay: t.payPrefix,
      total: t.total,
      opening: t.openingTitle,
      openingApp: wallet ? t.openingWallet(wallet) : t.openingTitle,
      // El aviso del último minuto; el JS pone la hora.
      soon: t.lastMinute('{time}'),
      // Los errores de «Otra» (solo si hay propinas).
      empty: withTips ? t.tipOtherEmpty : '',
      tooHigh: withTips ? t.tipOtherTooHigh(clientMoney(Math.floor((view.tipMaxCents ?? 0) / 100) * 100, t.locale, view.currency)) : '',
    },
  });
  const start = dueCents(view) + presetTip(view);
  const left = secondsLeft(view.qrExpiresAt, ctx.now);
  const soon = left <= LAST_MINUTE_S;
  return `<main class="pay">
<header class="head">
${view.venueName ? `<p class="venue">${escapeHtml(view.venueName)}</p>` : ''}
${whoLine(view, t)}
<p class="kick" aria-hidden="true">${escapeHtml(t.totalToPay)}</p>
<h1 class="amount num"><span class="sr">${escapeHtml(t.totalToPay)}: </span><span id="big">${escapeHtml(money(start, view, t, true))}</span></h1>
${view.concept ? `<p class="concept">${escapeHtml(view.concept)}</p>` : ''}
<p class="meta">${ctx.statementName ? `<span>${escapeHtml(t.statement(ctx.statementName))}</span>` : ''}<span id="exp"${soon ? ' hidden' : ''}>${escapeHtml(t.expiresIn)} <b class="num" id="left">${clockText(left)}</b></span><span class="soon" id="soon"${soon ? '' : ' hidden'}>${escapeHtml(t.lastMinute(clockText(left)))}</span></p>
</header>
<form id="pay" method="POST" action="${escapeHtml(action)}" data-expires="${view.qrExpiresAt.getTime()}" data-now="${ctx.now.getTime()}">
<input type="hidden" name="lang" value="${ctx.lang}">
${withTips ? tipChoices(view, t) : '<input type="hidden" name="tip" value="0">'}
${breakdown(view, t, withTips)}
<p class="sr" id="live" aria-live="polite" aria-atomic="true"></p>
${inApp ? `<p class="warn" role="note">${escapeHtml(t.inAppWarning(inApp))}</p>` : ''}
${keepRuleLine(view, ctx.lang)}
${payButtons(view, t, ctx)}
</form>
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
