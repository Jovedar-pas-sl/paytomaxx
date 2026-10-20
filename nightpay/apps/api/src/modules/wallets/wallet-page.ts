import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { CLUB_BASE_CSS, brandWordmark, escapeHtml, jsConfig } from '../payments/club-ui';
import type { ClientWalletState } from './wallet-charges.service';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import { CLIENT_ERROR_JS, clientErrorConfig } from './client-errors';
import { WALLET_TEXT } from './wallet-text';
import { GOOGLE_WALLET_BUTTONS } from './google-wallet/google-wallet-button';
import type { TopUpOptions, TopUpProof } from './wallet-topup.service';
import { TOPUP_CSS, TOPUP_JS, paidProofScript, paidProofSection, topUpCard, topUpOffNote } from './wallet-topup-view';
import { SCAN_CSS, SCAN_JS, scanArea } from './wallet-scan';

/**
 * Página del saldo del cliente (/w/:token). HTML autocontenido, marca
 * OxioCard: el saldo va en la tarjeta del local al estilo OxioCard (verde
 * profundo, brillo en diagonal y borde lima) y, debajo, dos opciones iguales: «Pagar» y
 * «Recargar» (pestañas: solo se ve una vista a la vez).
 *  - «Pagar» (la de entrada): escanear el QR del personal (con la cámara en
 *    la página si hay BarcodeDetector; si no, con la del móvil), activar el
 *    desbloqueo del móvil si falta, «Sin móvil»: el código y el PIN (o la
 *    ficha), y Google Wallet (solo Android y si está configurado).
 *  - «Recargar»: cuánto, los límites y Apple Pay / Google Pay o tarjeta
 *    (wallet-topup-view.ts). Al volver del banco se abre aquí con su «Pagado».
 *    Si el local no deja recargar, no hay opciones: solo «Pagar».
 * Debajo de las dos, «Más»: elegir PIN, juntar saldos, «Me voy» (en hojas
 * dentro de la página: nada de confirm()/alert()) y los movimientos. El
 * estado se refresca cada pocos segundos. Aquí no se cobra: se paga en la
 * página del cobro (/s/…) o con el PIN en el móvil del personal.
 * Todo texto dinámico va con textContent (nada de HTML inyectado).
 */

const WALLET_CSS = `
.w{max-width:26rem;margin:0 auto;padding:1rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.top{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:3rem}
.top .wm{height:1.3rem}
.hero{position:relative;isolation:isolate;overflow:hidden;min-height:10.5rem;padding:1rem 1.15rem;border-radius:24px;display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;text-align:left;color:var(--cream);background:var(--bits),linear-gradient(135deg,var(--green-1) 0%,var(--green-2) 55%,var(--green-3) 100%);box-shadow:0 0 0 1px var(--lime-edge),0 18px 40px -20px var(--lime-glow)}
.hero::before{content:'';position:absolute;top:1rem;right:1.1rem;width:1.5rem;height:1.5rem;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23EFE9DF' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M5.5 10.5a2 2 0 0 1 0 3'/%3E%3Cpath d='M9 8a6 6 0 0 1 0 8'/%3E%3Cpath d='M12.5 5.5a9.5 9.5 0 0 1 0 13'/%3E%3Cpath d='M16 3a13 13 0 0 1 0 18'/%3E%3C/svg%3E") center/contain no-repeat}
.hero::after{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(118deg,transparent 38%,var(--lime-soft) 50%,transparent 62%);pointer-events:none}
.hero p{color:var(--cream)}
#balanceLabel{padding-right:2rem;font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.balance{font-size:clamp(3rem,15vw,3.75rem);font-weight:800;letter-spacing:-.04em;line-height:1;margin-top:.25rem}
.status{font-weight:700}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.segb{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.35rem;min-height:5.5rem;padding:.75rem .5rem;border:1px solid var(--line-hi);border-radius:var(--r);background:var(--surface-2);color:var(--fg);font:inherit;font-size:1.3rem;font-weight:800;line-height:1.1;cursor:pointer;transition:transform .15s var(--ease)}
.segb svg{width:1.9rem;height:1.9rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.segb[aria-selected=true]{border-color:var(--fg);background:var(--fg);color:var(--ink-0)}
.segb:active{transform:scale(.98)}
.segb:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.view{display:flex;flex-direction:column;gap:1rem}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1.1rem;display:flex;flex-direction:column;gap:.7rem;background:var(--surface)}
.card h2{font-size:1.3rem;line-height:1.2}
.card h2.kick{font-size:.8rem}
.card h2.sub{font-size:1.1rem}
.card.main{border:1.5px solid var(--lime-edge)}
.how{color:var(--fg)}
.code{font-size:2.2rem;font-weight:800;letter-spacing:.2em;color:var(--fg);text-align:center}
.small{font-size:.85rem}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:.4rem;text-align:center}
.steps li{display:flex;flex-direction:column;align-items:center;gap:.3rem;font-size:.85rem;font-weight:700;color:var(--dim)}
.steps li::before{content:'○';display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;border:2px solid var(--line);font-size:.9rem}
.steps li.ok{color:var(--fg)}
.steps li.ok::before{content:'✓';border-color:var(--lime);background:var(--lime);color:var(--ink)}
.steps li.now{color:var(--lime)}
.steps li.now::before{content:'●';border-color:var(--lime)}
.more{display:flex;flex-direction:column;gap:.25rem;margin-top:.5rem}
.rows{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.row{display:flex;flex-direction:column;align-items:flex-start;gap:.1rem;width:100%;min-height:3.5rem;padding:.7rem .25rem;border:0;border-bottom:1px solid var(--line);background:none;color:var(--fg);font:inherit;font-weight:700;text-align:left;cursor:pointer}
.row small{font-weight:500;color:var(--mute);font-size:.85rem}
.row:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.row[aria-expanded]{position:relative;padding-right:2rem}
.row[aria-expanded]::after{content:'+';position:absolute;right:.5rem;top:50%;transform:translateY(-50%);font-size:1.4rem;color:var(--mute)}
.row[aria-expanded=true]::after{content:'−'}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
li.mv{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--line);font-size:.95rem}
li.mv span:first-child{color:var(--mute)}
li.mv .plus{color:var(--ok);font-weight:700}
li.mv .minus{color:var(--fg);font-weight:700}
dialog.sheet{position:fixed;inset:auto 0 0 0;width:100%;max-width:30rem;max-height:92vh;margin:0 auto;overflow:auto;border:0;border-top:1px solid var(--line-hi);border-radius:30px 30px 0 0;padding:1.5rem 1rem calc(1.25rem + env(safe-area-inset-bottom));background:var(--surface);color:var(--fg);display:none;flex-direction:column;gap:.8rem;text-align:center}
dialog.sheet[open]{display:flex;animation:np-up .28s var(--ease)}
dialog.sheet::backdrop{background:var(--scrim)}
dialog.sheet h2{font-size:1.4rem}
@keyframes np-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes np-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){dialog.sheet[open]{animation:np-in .2s ease}}
.pins{display:flex;gap:.5rem;justify-content:center}
.pins input{width:7.5rem;min-height:3.25rem;font:inherit;font-size:1.4rem;text-align:center;border-radius:14px;border:2px solid var(--line-hi);background:var(--surface-2);color:var(--fg);letter-spacing:.3em}
.pins input:focus-visible{outline:3px solid var(--lime);outline-offset:2px}
.pins input::placeholder{letter-spacing:normal;font-size:1rem;color:var(--dim)}
.gw{display:flex;flex-direction:column;align-items:center;gap:.5rem;padding:.5rem 0;text-align:center}
.gwb{display:block;max-width:100%;padding:0;margin:.5rem 0;border:0;border-radius:28px;background:none;line-height:0;cursor:pointer}
.gwb img{display:block;height:3.5rem;width:auto;max-width:100%;object-fit:contain}
.gwb:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.gwb:disabled{cursor:progress}
.toast{position:fixed;left:1rem;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom));max-width:26rem;margin:0 auto;padding:.9rem 1rem;border-radius:999px;background:var(--fg);color:var(--ink);font-weight:700;text-align:center;z-index:10;animation:np-in .2s ease}
`;

/** Iconos de las dos opciones (decorativos: el texto dice lo que es). */
const PAY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18h2"/></svg>';
const TOPUP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>';

function eur(cents: number, locale: string): string {
  return (cents / 100).toLocaleString(locale, { style: 'currency', currency: 'EUR' });
}

/** Textos que necesita el JS de la página (los del desbloqueo, de pay-i18n). */
function jsText(lang: PayLanguage): Record<string, unknown> {
  const p = PAY_TEXT[lang];
  return {
    ...WALLET_TEXT[lang],
    unlock: p.unlock,
    unlockWaiting: p.unlockWaiting,
  };
}

export interface WalletPageOptions {
  /** Google Wallet configurado: el botón oficial sale (solo en Android). */
  googleWallet?: boolean;
  /** «Recargar»: si se puede ahora y con qué importes (sin esto, no sale). */
  topUp?: TopUpOptions | null;
  /** Vuelta del banco tras pagar una recarga de este saldo: su «Pagado». */
  paid?: TopUpProof | null;
  /** Hora del servidor (para el «Pagado»). */
  now?: Date;
}

/**
 * «Añadir a Google Wallet» en «Pagar»: solo en Android, con el botón oficial
 * servido desde nuestro dominio (sin dibujarlo ni retocarlo: alto mínimo
 * 48 dp y 8 dp libres alrededor, normas de marca de Google).
 */
function googleWalletSection(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const b = GOOGLE_WALLET_BUTTONS[lang];
  const h = escapeHtml;
  return `<section class="gw" id="gwCard" hidden aria-label="Google Wallet">
<button class="gwb" type="button" id="gwAdd"><img src="/w/assets/google-wallet/${lang}" width="${b.width}" height="${b.height}" alt="${h(b.alt)}"></button>
<p class="small" id="gwMsg" role="status">${h(t.gwHint)}</p>
<p class="err" id="gwErr" role="alert" hidden></p>
</section>
`;
}

/**
 * Al tocarlo: el API prepara el pase y devuelve el enlace de Google para
 * guardarlo. Solo se abre si es de verdad de Google (pay.google.com).
 */
const GOOGLE_WALLET_JS = `
$('gwAdd').addEventListener('click',function(){var b=$('gwAdd');if(busy)return;busy=true;b.disabled=true;
 $('gwMsg').textContent=T.gwPreparing;show('gwErr','');
 post('/google-wallet').then(function(r){var u=r&&r.saveUrl;
   if(typeof u==='string'&&u.indexOf('https://pay.google.com/gp/v/save/')===0)location.href=u;else show('gwErr',T.error);})
  .catch(function(e){show('gwErr',msg(e));})
  .then(function(){busy=false;b.disabled=false;$('gwMsg').textContent=T.gwHint;});});`;

/** «Pagar» / «Recargar»: pestañas (las enseña el JS solo si se puede recargar). */
function viewTabs(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<div class="seg" role="tablist" id="seg" aria-label="${h(t.views)}" hidden>
<button class="segb" type="button" role="tab" id="tabPay" aria-controls="viewPay" aria-selected="true">${PAY_ICON}${h(t.pay)}</button>
<button class="segb" type="button" role="tab" id="tabTop" aria-controls="viewTop" aria-selected="false" tabindex="-1">${TOPUP_ICON}${h(t.topUp)}</button>
</div>
`;
}

/** Vista «Pagar»: el QR del personal (o activar el desbloqueo), sin móvil y Google Wallet. */
function payView(lang: PayLanguage, state: ClientWalletState, gw: boolean): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<section class="view" id="viewPay" aria-labelledby="tabPay">
<section class="card main" id="payCard" hidden aria-labelledby="payTitle">
<h2 id="payTitle">${h(t.scanTitle)}</h2>
<div class="stack" id="faceCard" hidden><p id="faceWhy">${h(t.payFaceWhy)}</p>
<button class="btn" type="button" id="faceOn"></button>
<p class="err" id="faceErr" role="alert" hidden></p></div>
${scanArea(lang)}</section>
<section class="card how" id="howCard" hidden><p class="how" id="howText"></p></section>
<p class="how" id="payEmpty" hidden>${h(t.payEmpty)}</p>
<section class="card" id="codeCard" aria-labelledby="codeTitle"><h2 class="sub" id="codeTitle">${h(t.codeTitle)}</h2><p class="code num" id="code">${h(state.code)}</p>
<p class="small" id="codeHint"></p><p class="small" id="fichaHint" hidden>${h(t.codeFicha)}</p></section>
${gw ? googleWalletSection(lang) : ''}</section>
`;
}

/** Vista «Recargar»: el «Pagado» si vuelve del banco y cuánto recargar. */
function topUpView(lang: PayLanguage, options: WalletPageOptions): string {
  const proof = options.paid ?? null;
  return `<section class="view" id="viewTop" aria-labelledby="tabTop" hidden>
${proof ? paidProofSection(lang, proof, options.now ?? new Date()) : ''}${topUpCard(lang, options.topUp ?? null)}</section>
`;
}

/** «Más»: lo que no es pagar ni recargar (las hojas y los movimientos). */
function moreList(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<section class="more" id="more" aria-labelledby="moreTitle">
<h2 class="kick" id="moreTitle">${h(t.more)}</h2>
<div class="rows">
<button class="row" type="button" id="pinOpen" hidden>${h(t.pinRow)}<small>${h(t.pinRowHint)}</small></button>
<button class="row" type="button" id="mergeOpen" hidden>${h(t.mergeRow)}<small>${h(t.mergeRowHint)}</small></button>
<button class="row" type="button" id="leaveOpen" hidden>${h(t.leaveRow)}<small>${h(t.leaveRowHint)}</small></button>
<button class="row" type="button" id="movOpen" aria-expanded="false" aria-controls="movBox">${h(t.movements)}<small>${h(t.movementsHint)}</small></button>
<div id="movBox" hidden><ul id="movements"></ul></div>
</div>
</section>
`;
}

/**
 * Las dos vistas: setView('pay'|'top') enseña una (y su pestaña marcada);
 * segShow(on) enseña o quita las pestañas (sin ellas, solo «Pagar»). Flechas,
 * Inicio y Fin cambian de pestaña (patrón de pestañas de WAI-ARIA).
 */
const VIEWS_JS = `
var view=C.paid?'top':'pay';
function setView(v,focus){var pay=v!=='top';view=pay?'pay':'top';
 $('tabPay').setAttribute('aria-selected',String(pay));$('tabTop').setAttribute('aria-selected',String(!pay));
 $('tabPay').tabIndex=pay?0:-1;$('tabTop').tabIndex=pay?-1:0;
 $('viewPay').hidden=!pay;$('viewTop').hidden=pay;
 if(!pay){if(SC.on)scanStop();topOpen();}
 if(focus)$(pay?'tabPay':'tabTop').focus();}
function segShow(on){var was=!$('seg').hidden;$('seg').hidden=!on;
 ['viewPay','viewTop'].forEach(function(id){if(on)$(id).setAttribute('role','tabpanel');else $(id).removeAttribute('role');});
 if(!on&&view==='top')setView('pay');else if(on&&!was)setView(view);}
$('tabPay').addEventListener('click',function(){setView('pay');});
$('tabTop').addEventListener('click',function(){setView('top');});
$('seg').addEventListener('keydown',function(e){var k=e.key,to=k==='Home'?'pay':k==='End'?'top':k==='ArrowLeft'||k==='ArrowRight'?(view==='pay'?'top':'pay'):'';
 if(!to)return;e.preventDefault();setView(to,true);});
$('movOpen').addEventListener('click',function(){var b=$('movOpen'),open=b.getAttribute('aria-expanded')!=='true';
 b.setAttribute('aria-expanded',String(open));$('movBox').hidden=!open;});`;

export function renderWalletPage(
  token: string,
  lang: PayLanguage,
  state: ClientWalletState,
  options: WalletPageOptions = {},
): string {
  const t = WALLET_TEXT[lang];
  const base = `/w/${encodeURIComponent(token)}`;
  const gw = options.googleWallet === true;
  const proof = options.paid ?? null;
  const topUp = options.topUp ?? null;
  const config = jsConfig({
    base,
    lang,
    locale: t.locale,
    text: jsText(lang),
    errors: clientErrorConfig(lang),
    state,
    gw,
    topUp,
    paid: proof !== null,
  });
  const h = escapeHtml;
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0f1112"><title>${h(t.title)}</title>
<style>${CLUB_BASE_CSS}${WALLET_CSS}${SCAN_CSS}${TOPUP_CSS}</style></head><body><main class="w">
<div class="top"><p class="kick">${brandWordmark('')}<span class="sr">${h(t.title)}</span></p><a class="link" id="lang" href="${h(`${base}?lang=${t.other.code}`)}" lang="${t.other.code}" hreflang="${t.other.code}">${h(t.other.label)}</a></div>
<section class="hero" aria-labelledby="balanceLabel">
<p id="balanceLabel">${h(t.balance)}</p>
<p class="balance num" id="balance" aria-live="polite">${h(eur(state.balanceCents, t.locale))}</p>
<p class="status" id="notice" role="status" hidden></p>
</section>
${topUpOffNote()}<section class="card main" id="refundCard" hidden aria-labelledby="refundTitle">
<h2 id="refundTitle"></h2>
<ol class="steps" id="steps">${t.steps.map((s, i) => `<li data-i="${i}">${h(s)}</li>`).join('')}</ol>
<p id="refundHow"></p>
</section>
${viewTabs(lang)}${payView(lang, state, gw)}${topUpView(lang, options)}${moreList(lang)}<p class="small">${h(t.saveHint)}</p>
</main>
<dialog class="sheet" id="leaveSheet" aria-labelledby="leaveTitle">
<h2 id="leaveTitle"></h2><p id="leaveHow"></p>
<p class="err" id="leaveErr" role="alert" hidden></p>
<button class="btn" type="button" id="leaveGo">${h(t.leaveGo)}</button>
<button class="link" type="button" data-close>${h(t.cancel)}</button>
</dialog>
<dialog class="sheet" id="pinSheet" aria-labelledby="pinTitle">
<h2 id="pinTitle">${h(t.pinTitle)}</h2><p id="pinWhy"></p>
<form id="pinForm" autocomplete="off" style="display:flex;flex-direction:column;gap:.8rem">
<div class="pins"><input id="pin1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(t.pinLabel)}" placeholder="${h(t.pinLabel)}"><input id="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(t.pinRepeat)}" placeholder="${h(t.pinRepeat)}"></div>
<p class="err" id="pinErr" role="alert" hidden></p>
<button class="btn" type="submit" id="pinGo">${h(t.pinSave)}</button>
</form>
<button class="link" type="button" data-close>${h(t.cancel)}</button>
</dialog>
<dialog class="sheet" id="mergeSheet" aria-labelledby="mergeTitle">
<h2 id="mergeTitle">${h(t.mergeTitle)}</h2><p>${h(t.mergeWhy)}</p>
<p class="err" id="mergeErr" role="alert" hidden></p>
<button class="btn" type="button" id="mergeGo">${h(t.mergeButton)}</button>
<button class="link" type="button" data-close>${h(t.cancel)}</button>
</dialog>
<p class="toast" id="toast" role="status" hidden></p>
<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
(function(){
var C=JSON.parse(${config}),T=C.text,S=C.state,busy=false,toastT;
function $(id){return document.getElementById(id);}
function eur(c){return (c/100).toLocaleString(C.locale,{style:'currency',currency:'EUR'});}
function fill(s,k,v){return s.split('{'+k+'}').join(v);}
function when(iso){return new Date(iso).toLocaleString(C.locale,{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function show(id,text){$(id).textContent=text||'';$(id).hidden=!text;}
function toast(text){show('toast',text);clearTimeout(toastT);toastT=setTimeout(function(){show('toast','');},4000);}
var ua=navigator.userAgent||'',P=/iPhone|iPad|iPod/.test(ua)||(ua.indexOf('Macintosh')>-1&&navigator.maxTouchPoints>1)?'ios':ua.indexOf('Android')>-1?'android':'other',U=T.unlock[P];
function cards(){return (S.cards||[]).map(function(c){return '••'+c;}).join(' · ');}
var gw=C.gw?$('gwCard'):null;
function openSheet(d){if(d.showModal){if(!d.open)d.showModal();}else d.setAttribute('open','');}
function closeSheet(d){if(d.close&&d.open)d.close();else d.removeAttribute('open');}
Array.prototype.forEach.call(document.querySelectorAll('dialog.sheet'),function(d){
 d.addEventListener('click',function(e){if(e.target===d||e.target.hasAttribute('data-close'))closeSheet(d);});});
function busyBtn(b,on,label){b.disabled=on;b.textContent=on?label:b.getAttribute('data-label');}
['leaveGo','pinGo','mergeGo'].forEach(function(id){$(id).setAttribute('data-label',$(id).textContent);});
$('faceOn').textContent=U.button;$('faceOn').setAttribute('data-label',U.button);
$('pinWhy').textContent=fill(T.pinWhy,'code',S.code);
function refundView(r){
 $('refundTitle').textContent=fill(T.refundTitle,'amount',eur(r.amountCents));
 var at=r.stage==='requested'?1:r.stage==='approved'?2:3;
 Array.prototype.forEach.call($('steps').children,function(li,i){li.className=i<at?'ok':i===at?'now':'';
  if(i===at)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
 var m=r.methods,how;
 if(r.stage==='requested')how=S.cards.length?fill(T.refundRequestedCards,'cards',cards()):T.refundRequested;
 else if(r.stage==='approved')how=fill(T.refundApproved,'cards',cards());
 else how=m.length===1&&m[0]==='CASH'?T.refundDoneCash:m.length>1?fill(T.refundDoneMixed,'cards',cards()):fill(T.refundDoneCard,'cards',cards());
 $('refundHow').textContent=how;}
// «Pagar»: con el desbloqueo activado, escanear; sin él, activarlo; sin poder usarlo aquí, el PIN.
function payRender(s,active,r){var canKey=pkSupported(),payable=active&&!r;
 var setup=payable&&!s.hasFaceId&&canKey,scan=payable&&s.hasFaceId&&canKey;
 $('payCard').hidden=!(setup||scan);$('payTitle').textContent=setup?U.title:T.scanTitle;
 $('faceCard').hidden=!setup;$('scanArea').hidden=!scan;if(!scan&&SC.on)scanStop();
 $('faceDone').textContent=scan?'✓ '+U.done+' '+T.payFaceDone:'';
 show('howText',payable&&!canKey?(s.hasFaceId?T.faceIdNeeded:T.unlockUnsupported):'');$('howCard').hidden=$('howText').hidden;
 $('codeCard').hidden=!active;$('codeHint').textContent=s.hasPin?T.codeWithPin:T.codeNoPin;$('fichaHint').hidden=!s.hasCard;
 if(gw)gw.hidden=!(P==='android'&&active&&!r&&!s.merged);}
function render(s){S=s;S.cards=s.cards||[];
 $('balance').textContent=eur(s.balanceCents);$('code').textContent=s.code;
 var active=s.status==='ACTIVE',r=s.refund;
 var notice=active?'':s.status==='DEPLETED'?(s.merged?T.merged:T.depleted):r?'':T.closed;
 show('notice',notice);
 $('refundCard').hidden=!r;if(r)refundView(r);
 payRender(s,active,r);
 $('pinOpen').hidden=!(active&&!r&&!s.hasPin);
 $('mergeOpen').hidden=!(active&&!r&&!s.hasFaceId&&!s.merged&&s.balanceCents>0);
 $('leaveOpen').hidden=!(active&&s.balanceCents>0&&!s.closeRequested);
 var ul=$('movements');ul.textContent='';
 if(!s.movements.length){var e=document.createElement('li');e.className='mv';e.textContent=T.noMovements;ul.appendChild(e);}
 s.movements.forEach(function(m){var li=document.createElement('li'),a=document.createElement('span'),b=document.createElement('span');li.className='mv';
  a.textContent=[m.label,m.venueName,when(m.at)].filter(Boolean).join(' · ');
  b.textContent=(m.amountCents>0?'+':'')+eur(m.amountCents);b.className=(m.amountCents>0?'plus':'minus')+' num';
  li.appendChild(a);li.appendChild(b);ul.appendChild(li);});
 var can=topRender(s);
 $('payEmpty').hidden=!(can&&s.status==='DEPLETED');
 segShow(can||C.paid);}
function post(path,body){return pkPost(C.base+path,body||{});}
function refresh(){if(busy)return;fetch(C.base+'/state',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(s){if(s&&!busy)render(s);}).catch(function(){});}
function msg(e){return npErr(e,C.errors);}
// Saldo con Face ID: elegir PIN y «Me voy» piden desbloquear el móvil (reto atado a la acción).
function withKey(path,body){if(!S.hasFaceId)return post(path,body);
 return pkGet(C.base+path+'/challenge').then(function(k){body.response=k;return post(path,body);});}
$('faceOn').addEventListener('click',function(){var b=$('faceOn');if(busy)return;busy=true;busyBtn(b,true,T.unlockWaiting);show('faceErr','');
 pkCreate(C.base+'/passkey/options').then(function(k){return post('/passkey',{response:k});})
  .then(function(s){render(s);toast('✓ '+U.done);}).catch(function(e){if(!pkCancelled(e))show('faceErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('leaveOpen').addEventListener('click',function(){
 $('leaveTitle').textContent=fill(T.leaveTitle,'amount',eur(S.balanceCents));
 $('leaveHow').textContent=S.cards.length?fill(T.leaveWaysCards,'cards',cards()):T.leaveWays;
 show('leaveErr','');openSheet($('leaveSheet'));});
$('leaveGo').addEventListener('click',function(){var b=$('leaveGo');if(busy)return;show('leaveErr','');
 if(S.hasFaceId&&!pkSupported()){show('leaveErr',T.faceIdNeeded);return;}
 busy=true;busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.sending);
 withKey('/close',{}).then(function(s){render(s);closeSheet($('leaveSheet'));toast(T.leaveDone);}).catch(function(e){if(!pkCancelled(e))show('leaveErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('pinOpen').addEventListener('click',function(){$('pin1').value='';$('pin2').value='';show('pinErr','');openSheet($('pinSheet'));$('pin1').focus();});
$('pinForm').addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;show('pinErr','');
 var a=$('pin1').value,c=$('pin2').value;
 if(!/^[0-9]{4}$/.test(a)){show('pinErr',T.pinFormat);return;}
 if(a!==c){show('pinErr',T.pinMismatch);return;}
 if(S.hasFaceId&&!pkSupported()){show('pinErr',T.faceIdNeeded);return;}
 var b=$('pinGo');busy=true;busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.sending);
 withKey('/pin',{pin:a,pin2:c}).then(function(s){render(s);closeSheet($('pinSheet'));toast(T.pinDone);})
  .catch(function(e){$('pin1').value='';$('pin2').value='';if(!pkCancelled(e))show('pinErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('mergeOpen').addEventListener('click',function(){show('mergeErr','');openSheet($('mergeSheet'));});
$('mergeGo').addEventListener('click',function(){var b=$('mergeGo');if(busy)return;busy=true;busyBtn(b,true,T.unlockWaiting);show('mergeErr','');
 pkGet(C.base+'/merge/challenge').then(function(k){return post('/merge',{response:k});})
  .then(function(r){closeSheet($('mergeSheet'));toast(fill(T.mergeDone,'amount',eur(r.balanceCents)));busy=false;refresh();})
  .catch(function(e){if(!pkCancelled(e))show('mergeErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});${gw ? GOOGLE_WALLET_JS : ''}
${SCAN_JS}
${TOPUP_JS}
${VIEWS_JS}
if(!C.paid&&S.status==='DEPLETED'&&topCan(S))view='top';
render(S);
if(C.paid){try{history.replaceState(null,'',C.base+'?lang='+C.lang);}catch(e){}}
if(location.hash==='#sumar'&&!$('mergeOpen').hidden)openSheet($('mergeSheet'));
setInterval(function(){if(document.visibilityState==='visible')refresh();},3000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')refresh();});
})();
${proof ? paidProofScript(lang) : ''}
</script></body></html>`;
}
