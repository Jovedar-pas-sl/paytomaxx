import { escapeHtml, jsConfig } from '../payments/club-ui';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { PAID_FRESH_MS, PAID_SCREEN_JS, formatAgo, paidScreenJsText } from '../payments/paid-screen';
import { receiptHref } from '../payments/public-pay.pages';
import { WALLET_TEXT } from './wallet-text';
import type { TopUpOptions, TopUpProof } from './wallet-topup.service';

/**
 * La vista «Recargar» de la página del saldo (/w/:token): cuánto (las
 * sugeridas, «Otra» y los límites) y a pagar con Apple Pay / Google Pay o
 * tarjeta; el aviso si ahora no se puede, y el «Pagado» al volver del banco.
 * Lo usa wallet-page.ts.
 *
 * El JS va dentro de plantillas de TypeScript: sin barras invertidas.
 */

export const TOPUP_CSS = `
.topup{text-align:center}
.tform{display:flex;flex-direction:column;gap:.8rem}
.tform fieldset{border:0;margin:0;padding:0;min-width:0}
.amts{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.amts label{display:block;position:relative}
.amts input{position:absolute;opacity:0;width:1px;height:1px}
.amts span{position:relative;display:flex;align-items:center;justify-content:center;min-height:3.5rem;padding:.5rem 1.4rem;border:2px solid var(--line);border-radius:12px;font-size:1.2rem;font-weight:800;color:var(--fg);cursor:pointer;transition:transform .15s var(--ease)}
.amts input:checked+span{border-color:var(--lime);background:#1b2208;color:var(--lime);box-shadow:inset 0 0 0 1px var(--lime)}
.amts input:checked+span::before{content:'✓';position:absolute;top:.35rem;right:.55rem;font-size:.9rem;font-weight:900}
.amts input:focus-visible+span{outline:3px solid var(--fg);outline-offset:2px}
.amts span:active{transform:scale(.97)}
.tother{display:flex;flex-direction:column;align-items:center;gap:.35rem}
.tother label{font-weight:600;color:var(--mute)}
.teur{display:flex;align-items:center;gap:.4rem}
.teur input{width:7rem;min-height:3.25rem;font:inherit;font-size:1.6rem;font-weight:800;text-align:center;border-radius:12px;border:2px solid var(--lime);background:var(--bg);color:var(--fg)}
.teur input:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.teur span{font-size:1.4rem;font-weight:800}
.proof{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:.2rem .85rem;padding:1rem 1.1rem;border-radius:var(--r);background:var(--lime);color:var(--ink)}
.proof p,.proof a{color:inherit}
.proof .band{position:absolute;top:-50%;left:-50%;width:200%;height:200%;z-index:-1;background:repeating-linear-gradient(-45deg,rgba(11,11,11,.09) 0 30px,rgba(11,11,11,0) 30px 60px);animation:np-band 8s linear infinite;will-change:transform}
@keyframes np-band{from{transform:translate3d(0,0,0)}to{transform:translate3d(84.85px,0,0)}}
@media (prefers-reduced-motion:reduce){.proof .band{animation:none}}
.proof .tick{grid-row:span 2;width:2.6rem;height:2.6rem;stroke:currentColor;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.proof h2{font-size:1.7rem;font-weight:900;text-transform:uppercase;line-height:1}
.proof .pwhat{font-weight:800;font-size:1.05rem}
.proof .pmeta{grid-column:1/-1;display:flex;flex-wrap:wrap;justify-content:space-between;gap:.15rem .75rem;margin-top:.35rem;font-weight:700}
.proof .pcode b{letter-spacing:.2em}
.proof .pnote{grid-column:1/-1;font-size:.9rem;font-weight:600}
.proof .pstale{display:none;grid-column:1/-1;font-weight:800}
.proof .link{grid-column:1/-1;justify-content:flex-start;min-height:2.75rem;padding:0;color:inherit}
.proof.stale{background:var(--stale);color:var(--fg)}
.proof.stale .band{display:none}
.proof.stale .pstale{display:block}
`;

function short(cents: number, locale: string): string {
  return (cents / 100).toLocaleString(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

/** Aviso debajo del saldo si el saldo o el local no dejan recargar ahora (lo rellena el JS). */
export function topUpOffNote(): string {
  return `<p class="small" id="topupOff" role="status" hidden></p>
`;
}

/** Elegir cuánto: las sugeridas, «Otra» y los límites. Por defecto, la del medio. */
export function topUpCard(lang: PayLanguage, options: TopUpOptions | null): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  const presets = options?.presetsCents ?? [];
  const middle = presets[Math.floor((presets.length - 1) / 2)];
  const radios = presets
    .map(
      (c) =>
        `<label><input type="radio" name="amt" value="${c}"${c === middle ? ' checked' : ''}><span class="num">${h(short(c, t.locale))}</span></label>`,
    )
    .join('');
  const limits = options
    ? t.topUpLimits.replace('{min}', short(options.minCents, t.locale)).replace('{max}', short(options.maxCents, t.locale))
    : '';
  return `<section class="card topup" id="topupBox" hidden aria-labelledby="topupTitle">
<h2 id="topupTitle">${h(t.topUpTitle)}</h2><p>${h(t.topUpWhy)}</p>
<form id="topupForm" class="tform" autocomplete="off">
<fieldset><legend class="sr">${h(t.topUpAmount)}</legend><div class="amts">${radios}<label><input type="radio" name="amt" value="other" id="amtOther"><span>${h(t.topUpOther)}</span></label></div></fieldset>
<div class="tother" id="otherBox" hidden><label for="otherIn">${h(t.topUpOtherLabel)}</label>
<div class="teur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" aria-describedby="topupLimits"><span aria-hidden="true">€</span></div></div>
<p class="small" id="topupLimits">${h(limits)}</p>
<p class="small" id="topupKey" hidden></p>
<p class="err" id="topupErr" role="alert" hidden></p>
<button class="btn" type="submit" id="topupGo">${h(t.topUp)}</button>
<p class="small">${h(t.topUpMethods)}</p>
</form>
</section>
`;
}

/**
 * «Pagado» de la recarga al volver del banco, arriba de «Recargar» (el saldo
 * ya la lleva). Como el «Pagado» de /pay: la hora que corre, «hace 0:12» y, pasados
 * unos minutos, «Ya pagado» en gris (npPaid): una captura vieja no cuela.
 */
export function paidProofSection(lang: PayLanguage, proof: TopUpProof, now: Date): string {
  const t = WALLET_TEXT[lang];
  const p = PAY_TEXT[lang];
  const h = escapeHtml;
  const at = proof.authorizedAt ? Date.parse(proof.authorizedAt) : null;
  const fresh = at !== null && now.getTime() - at < PAID_FRESH_MS;
  const clock = now.toLocaleTimeString(p.locale, {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const what = t.proofWhat.replace('{amount}', (proof.amountCents / 100).toLocaleString(t.locale, { style: 'currency', currency: 'EUR' }));
  return `<section class="proof${fresh ? '' : ' stale'}" id="proof" data-at="${at ?? ''}" data-now="${now.getTime()}" data-fresh="${PAID_FRESH_MS}" aria-labelledby="proofTitle">
<div class="band" aria-hidden="true"></div>
<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>
<h2 id="proofTitle" data-title aria-live="polite">${h(fresh ? p.paidTitle : p.alreadyPaidTitle)}</h2>
<p class="pwhat num">${h(what)}</p>
<div class="pmeta"><span class="num" data-ago>${at !== null ? h(formatAgo(now.getTime() - at, p)) : ''}</span><span class="num" data-clock aria-label="${h(p.clockLabel)}">${h(clock)}</span><span class="pcode">${h(p.codeLabel)} <b class="num">${h(proof.code)}</b></span></div>
<p class="pnote">${h(t.proofAdded)}</p>
<p class="pstale">${h(p.notNewPayment)}</p>
<a class="link" href="${h(receiptHref(proof.payToken, lang))}">${h(p.receiptLink)}</a>
</section>
`;
}

/** Arranque del «Pagado» (va en el <script> de la página, tras el JS de la página). */
export function paidProofScript(lang: PayLanguage): string {
  return `${PAID_SCREEN_JS}
npPaid(document.getElementById('proof'),JSON.parse(${jsConfig(paidScreenJsText(PAY_TEXT[lang]))}));`;
}

/**
 * JS de «Recargar» (dentro del JS de la página: usa $, show, fill, post,
 * busy, busyBtn, msg, refresh, S, C, T).
 *  - topCan(s): se puede recargar (saldo activo o a cero, sin devolución
 *    pedida y el local lo permite). Si no, la página no enseña «Recargar».
 *  - topRender(s): la tarjeta si se puede; si no, el aviso de por qué.
 *  - topOpen(): al entrar en «Recargar», una clave nueva y sin errores viejos.
 *  - Con Face ID: reto + desbloqueo antes de crear la recarga (como sumar).
 *  - Una clave por intento (un doble toque es la misma recarga); nueva tras
 *    un error o al volver atrás desde el pago.
 *  - Solo se va a una página de pago nuestra (/pay/...).
 */
export const TOPUP_JS = `
var TU=C.topUp||{allowed:false,block:null,presetsCents:[],minCents:0,maxCents:0},TK='';
function newKey(){var a=new Uint8Array(16);crypto.getRandomValues(a);TK=pkB64u(a.buffer);}
function eurShort(c){return (c/100).toLocaleString(C.locale,{style:'currency',currency:'EUR',minimumFractionDigits:c%100===0?0:2});}
function topCents(){var r=$('topupForm').querySelector('input[name=amt]:checked');if(!r)return 0;
 if(r.value!=='other')return +r.value||0;return (parseInt($('otherIn').value.replace(/[^0-9]/g,'')||'0',10)||0)*100;}
function topOk(c){return c>=TU.minCents&&c<=TU.maxCents&&c%100===0;}
function topUpd(){var c=topCents(),b=$('topupGo'),label=topOk(c)?fill(T.topUpGo,'amount',eurShort(c)):T.topUp;
 $('otherBox').hidden=!$('amtOther').checked;b.setAttribute('data-label',label);if(!busy)b.textContent=label;}
function topUsable(s){return (s.status==='ACTIVE'||(s.status==='DEPLETED'&&!s.merged))&&!s.refund&&!s.closeRequested;}
function topCan(s){return topUsable(s)&&TU.allowed;}
function topRender(s){var usable=topUsable(s),can=usable&&TU.allowed;
 $('topupBox').hidden=!can;
 show('topupOff',usable&&!TU.allowed&&TU.block?(TU.block==='blocked'?T.topUpBlocked:T.topUpOff):'');
 return can;}
function topOpen(){if(busy)return;newKey();show('topupErr','');show('topupKey',S.hasFaceId?T.topUpFaceId:'');topUpd();}
$('topupForm').addEventListener('change',function(e){topUpd();if(e.target===$('amtOther')&&e.target.checked)$('otherIn').focus();});
$('otherIn').addEventListener('input',topUpd);
$('topupForm').addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;show('topupErr','');
 var c=topCents(),b=$('topupGo');
 if(!topOk(c)){show('topupErr',fill(fill(T.topUpRange,'min',eurShort(TU.minCents)),'max',eurShort(TU.maxCents)));return;}
 if(S.hasFaceId&&!pkSupported()){show('topupErr',T.topUpNoKey);return;}
 var body={amountCents:c,key:TK,lang:C.lang};busy=true;busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.topUpOpening);
 (S.hasFaceId?pkGet(C.base+'/topup/challenge').then(function(k){body.response=k;busyBtn(b,true,T.topUpOpening);return post('/topup',body);}):post('/topup',body))
  .then(function(r){var u=r&&r.payUrl;if(typeof u==='string'&&u.indexOf('/pay/')===0){location.href=u;return;}throw new Error(T.error);})
  .catch(function(e){newKey();busy=false;busyBtn(b,false);if(!pkCancelled(e))show('topupErr',msg(e));});});
window.addEventListener('pageshow',function(e){if(e.persisted){busy=false;newKey();busyBtn($('topupGo'),false);refresh();}});
newKey();topUpd();`;
