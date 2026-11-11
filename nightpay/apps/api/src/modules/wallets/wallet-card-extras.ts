import { clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import type { FichaCardText } from '../payments/i18n/types';
import type { PayLanguage } from '../payments/pay-i18n';
import type { TopUpOptions } from './wallet-topup.service';

/**
 * La ficha en el móvil del cliente (/w/card/<ficha>), debajo de lo de
 * siempre (estudio de fichas, B7):
 *  - «Recargar esta ficha»: solo suma, sin enseñar el saldo ni el enlace
 *    privado; con su propio freno (wallet-topup-rules: FICHA_TOPUP_*).
 *  - «Ver mi saldo con mi PIN»: 10 min, el mismo contador de fallos del PIN y
 *    sin pagos. No activa Face ID.
 * El JS va en plantillas de TypeScript: sin barras invertidas.
 */

export const CARD_EXTRAS_CSS = `
.fx{display:flex;flex-direction:column;gap:.75rem;padding:1rem 1.125rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
.fx h2{font-size:1.25rem;font-weight:600;line-height:1.2}
.fx .small{color:var(--mute);font-size:.875rem;line-height:1.4}
.famts{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;border:0;margin:0;padding:0;min-width:0}
.famts label{display:block;position:relative}
.famts input{position:absolute;opacity:0;width:1px;height:1px}
.famts span{display:flex;align-items:center;justify-content:center;min-height:3.25rem;border:1px solid var(--line-hi);border-radius:var(--r-field);background:var(--surface-2);font-family:var(--num);font-size:1.125rem;font-weight:600;color:var(--fg);cursor:pointer}
.famts input:checked+span{border-color:var(--fg);background:var(--fg);color:var(--bg)}
.famts input:focus-visible+span{outline:3px solid var(--fg);outline-offset:3px}
.fother{display:flex;align-items:center;gap:.5rem}
.fother input,.fpin input{width:8rem;min-height:3.25rem;font:inherit;font-family:var(--num);font-size:1.375rem;font-weight:600;text-align:center;border-radius:var(--r-field);border:1px solid var(--line-hi);background:var(--surface-2);color:var(--fg)}
.fpin{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}
.fbal{font-family:var(--num);font-size:2.5rem;font-weight:600;line-height:1}
`;

/** Las dos cosas de la ficha, si se pueden: la recarga (con importes) y ver el saldo con el PIN. */
export function cardExtrasHtml(t: FichaCardText, locale: string, topUp: TopUpOptions | null, hasPin: boolean): string {
  const h = escapeHtml;
  const money = (cents: number) => h(clientMoney(cents, locale));
  const topUpBox = topUp
    ? `<section class="fx" aria-labelledby="ftopT"><h2 id="ftopT">${h(t.topUpTitle)}</h2><p class="small">${h(t.topUpWhy)}</p>
<form id="ftopF" autocomplete="off"><fieldset class="famts"><legend class="sr">${h(t.topUpTitle)}</legend>${topUp.presetsCents
        .map((c, i) => `<label><input type="radio" name="famt" value="${c}"${i === 0 ? ' checked' : ''}><span>${money(c)}</span></label>`)
        .join('')}<label><input type="radio" name="famt" value="other" id="famtOther"><span>${h(t.topUpOther)}</span></label></fieldset>
<p class="fother" id="fotherBox" hidden><label for="fotherIn" class="sr">${h(t.topUpOtherLabel)}</label><input id="fotherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"><span aria-hidden="true">€</span></p>
<p class="small">${h(t.topUpLimits.replace('{min}', clientMoney(topUp.minCents, locale)).replace('{max}', clientMoney(topUp.maxCents, locale)))}${topUp.serviceFeeBps ? ` ${h(t.topUpFee)}` : ''}</p>
<p class="err" id="ftopErr" role="alert" hidden></p><button class="btn" type="submit" id="ftopGo">${h(t.topUpGo.replace('{amount}', clientMoney(topUp.presetsCents[0] ?? topUp.minCents, locale)))}</button></form></section>`
    : '';
  const pinBox = hasPin
    ? `<section class="fx" aria-labelledby="fpinT"><h2 id="fpinT">${h(t.pinTitle)}</h2><p class="small">${h(t.pinWhy)}</p>
<form id="fpinF" class="fpin" autocomplete="off"><label for="fpinIn">${h(t.pinLabel)}</label><input id="fpinIn" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off"><button class="btn" type="submit" id="fpinGo">${h(t.pinGo)}</button></form>
<p class="err" id="fpinErr" role="alert" hidden></p>
<div id="fpinOut" hidden role="status"><p class="small">${h(t.pinBalance)}</p><p class="fbal" id="fpinBal"></p><p class="small" id="fpinUntil"></p><button class="link" type="button" id="fpinAgain">${h(t.pinAgain)}</button></div></section>`
    : '';
  return topUpBox + pinBox;
}

/** El JS de las dos cosas (sin barras invertidas): la recarga va a /pay; el PIN enseña el saldo 10 min. */
export function cardExtrasScript(base: string, lang: PayLanguage, locale: string, t: FichaCardText): string {
  return `<script>
(function(){'use strict';var C=JSON.parse(${jsConfig({ base, lang, locale, t })}),T=C.t;
function $(i){return document.getElementById(i);}
function eur(c){return new Intl.NumberFormat(C.locale,{style:'currency',currency:'EUR',minimumFractionDigits:c%100?2:0}).format(c/100);}
function show(el,text){el.textContent=text||'';el.hidden=!text;}
function post(path,body){return fetch(C.base+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){if(!r.ok){var e=new Error(j.message||T.error);e.code=j.code;e.status=r.status;throw e;}return j;});});}
function newKey(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(b){return (b<16?'0':'')+b.toString(16);}).join('');}
var f=$('ftopF');
if(f){var K=newKey(),go=$('ftopGo'),err=$('ftopErr');
function cents(){var r=f.querySelector('input[name=famt]:checked');if(!r)return 0;if(r.value!=='other')return +r.value||0;return (parseInt(($('fotherIn').value||'').replace(/[^0-9]/g,''),10)||0)*100;}
function upd(){$('fotherBox').hidden=!$('famtOther').checked;var c=cents();go.textContent=c>0?T.topUpGo.split('{amount}').join(eur(c)):T.topUpGo.split('{amount}').join('').trim();}
f.addEventListener('change',function(e){upd();if(e.target===$('famtOther')&&e.target.checked)$('fotherIn').focus();});
$('fotherIn').addEventListener('input',upd);
f.addEventListener('submit',function(e){e.preventDefault();var c=cents();if(c<=0)return;go.disabled=true;go.textContent=T.topUpOpening;show(err,'');
post('/topup',{amountCents:c,key:K,lang:C.lang}).then(function(r){if(typeof r.payUrl!=='string'||r.payUrl.indexOf('/pay/')!==0)throw new Error(T.error);window.location.assign(r.payUrl);}).catch(function(x){go.disabled=false;upd();
show(err,x.status===429?T.rateLimited:x.code==='WALLET_TOPUP_DAILY_LIMIT'||x.code==='WALLET_TOPUP_PENDING_LIMIT'?T.topUpLimit:x.code==='WALLET_TOPUP_UNAVAILABLE'?T.topUpOff:x.code==='WALLET_TOPUP_AMOUNT'?T.topUpAmount:T.error);});});
upd();}
var p=$('fpinF');
if(p){var perr=$('fpinErr'),out=$('fpinOut'),pgo=$('fpinGo'),view=null,timer=0;
function hide(){out.hidden=true;view=null;show(perr,T.pinExpired);p.hidden=false;}
function seen(r){view=r.viewToken;$('fpinBal').textContent=eur(r.balanceCents);var until=new Date(r.expiresAt);
$('fpinUntil').textContent=T.pinUntil.split('{time}').join(until.toLocaleTimeString(C.locale,{hour:'2-digit',minute:'2-digit'}));
out.hidden=false;p.hidden=true;show(perr,'');clearTimeout(timer);timer=setTimeout(hide,Math.max(0,until.getTime()-Date.now()));}
function fail(x){show(perr,x.status===429?T.rateLimited:x.code==='PIN_LOCKED'?T.pinLocked:x.code==='PIN_FORMAT'?T.pinFormat:x.code==='CARD_VIEW_EXPIRED'?T.pinExpired:x.status===422?T.pinWrong:T.error);}
p.addEventListener('submit',function(e){e.preventDefault();var v=$('fpinIn').value;$('fpinIn').value='';if(!/^[0-9]{4}$/.test(v)){show(perr,T.pinFormat);return;}pgo.disabled=true;
post('/pin',{pin:v}).then(seen).catch(fail).then(function(){pgo.disabled=false;});});
$('fpinAgain').addEventListener('click',function(){if(!view)return hide();post('/saldo',{viewToken:view}).then(seen).catch(function(x){if(x.code==='CARD_VIEW_EXPIRED')return hide();fail(x);});});}
})();
</script>`;
}
