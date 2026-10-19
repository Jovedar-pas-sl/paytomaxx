import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { CLUB_BASE_CSS, escapeHtml, jsConfig } from '../payments/club-ui';
import type { ClientWalletState } from './wallet-charges.service';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import { WALLET_TEXT } from './wallet-text';
import { GOOGLE_WALLET_BUTTONS } from './google-wallet/google-wallet-button';
import type { TopUpOptions, TopUpProof } from './wallet-topup.service';
import { TOPUP_CSS, TOPUP_JS, paidProofScript, paidProofSection, topUpBox, topUpSheet } from './wallet-topup-view';

/**
 * Página del saldo del cliente (/w/:token). HTML autocontenido, look "Club".
 * El saldo es el protagonista y hay UNA acción principal (activar el pago
 * desbloqueando el móvil, o el seguimiento del «Me voy»); elegir PIN, sumar a
 * otro saldo y «Me voy» son secundarias y se hacen en hojas dentro de la
 * página (nada de confirm()/alert()). «Recargar» va debajo del saldo: principal
 * si no hay Face ID que activar, si no secundaria (wallet-topup-view.ts); al
 * volver del banco, su «Pagado» debajo del saldo y Google Wallet a mano.
 * «Añadir a Google Wallet» también es secundaria: solo en Android y si está
 * configurado. El estado se refresca cada pocos segundos. Aquí no se paga
 * (se paga con el QR del personal o con el PIN).
 * Todo texto dinámico va con textContent (nada de HTML inyectado).
 */

const WALLET_CSS = `
.w{max-width:26rem;margin:0 auto;padding:1rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.top{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.hero{padding:1.25rem 0 .5rem;text-align:center}
.balance{font-size:clamp(3.25rem,18vw,4.75rem);font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--fg);margin-top:.25rem}
.status{margin-top:.75rem;color:var(--fg);font-weight:600}
.card{border:2px solid var(--line);border-radius:var(--r);padding:1.1rem;display:flex;flex-direction:column;gap:.7rem;background:var(--surface)}
.card h2{font-size:1.3rem;line-height:1.2}
.card h2.kick{font-size:.8rem}
.card.main{border-color:var(--lime)}
.how{color:var(--fg)}
.code{font-size:2.2rem;font-weight:800;letter-spacing:.2em;color:var(--lime);text-align:center}
.small{font-size:.85rem}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:.4rem;text-align:center}
.steps li{display:flex;flex-direction:column;align-items:center;gap:.3rem;font-size:.85rem;font-weight:700;color:var(--dim)}
.steps li::before{content:'○';display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;border:2px solid var(--line);font-size:.9rem}
.steps li.ok{color:var(--fg)}
.steps li.ok::before{content:'✓';border-color:var(--lime);background:var(--lime);color:var(--ink)}
.steps li.now{color:var(--lime)}
.steps li.now::before{content:'●';border-color:var(--lime)}
.more{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.row{display:flex;flex-direction:column;align-items:flex-start;gap:.1rem;width:100%;min-height:3.5rem;padding:.7rem .25rem;border:0;border-bottom:1px solid var(--line);background:none;color:var(--fg);font:inherit;font-weight:700;text-align:left;cursor:pointer}
.row small{font-weight:500;color:var(--mute);font-size:.85rem}
.row:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
li.mv{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--line);font-size:.95rem}
li.mv span:first-child{color:var(--mute)}
li.mv .plus{color:var(--ok);font-weight:700}
li.mv .minus{color:var(--fg);font-weight:700}
dialog.sheet{position:fixed;inset:auto 0 0 0;width:100%;max-width:30rem;max-height:92vh;margin:0 auto;overflow:auto;border:0;border-radius:20px 20px 0 0;padding:1.5rem 1rem calc(1.25rem + env(safe-area-inset-bottom));background:var(--surface);color:var(--fg);display:none;flex-direction:column;gap:.8rem;text-align:center}
dialog.sheet[open]{display:flex;animation:np-up .28s var(--ease)}
dialog.sheet::backdrop{background:rgba(0,0,0,.65)}
dialog.sheet h2{font-size:1.4rem}
@keyframes np-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes np-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){dialog.sheet[open]{animation:np-in .2s ease}}
.pins{display:flex;gap:.5rem;justify-content:center}
.pins input{width:7.5rem;min-height:3.25rem;font:inherit;font-size:1.4rem;text-align:center;border-radius:12px;border:2px solid #45453f;background:var(--bg);color:var(--fg);letter-spacing:.3em}
.pins input:focus-visible{outline:3px solid var(--lime);outline-offset:2px}
.pins input::placeholder{letter-spacing:normal;font-size:1rem;color:var(--dim)}
.gw{display:flex;flex-direction:column;align-items:center;gap:.5rem;padding:.5rem 0;text-align:center}
.gwb{display:block;max-width:100%;padding:0;margin:.5rem 0;border:0;border-radius:28px;background:none;line-height:0;cursor:pointer}
.gwb img{display:block;height:3.5rem;width:auto;max-width:100%;object-fit:contain}
.gwb:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.gwb:disabled{cursor:progress}
.toast{position:fixed;left:1rem;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom));max-width:26rem;margin:0 auto;padding:.9rem 1rem;border-radius:12px;background:var(--fg);color:var(--ink);font-weight:700;text-align:center;z-index:10;animation:np-in .2s ease}
`;

function eur(cents: number, locale: string): string {
  return (cents / 100).toLocaleString(locale, { style: 'currency', currency: 'EUR' });
}

/** Textos que necesita el JS de la página (los del desbloqueo, de pay-i18n). */
function jsText(lang: PayLanguage): Record<string, unknown> {
  const p = PAY_TEXT[lang];
  return {
    ...WALLET_TEXT[lang],
    unlock: p.unlock,
    unlockWhy: p.unlockWhy,
    unlockWaiting: p.unlockWaiting,
    unlockAfter: p.unlockAfter,
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
 * «Añadir a Google Wallet»: acción secundaria, solo en Android, con el botón
 * oficial servido desde nuestro dominio (sin dibujarlo ni retocarlo: alto
 * mínimo 48 dp y 8 dp libres alrededor, normas de marca de Google).
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
  const config = jsConfig({ base, lang, locale: t.locale, text: jsText(lang), state, gw, topUp, paid: proof !== null });
  const h = escapeHtml;
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0b0b"><title>${h(t.title)}</title>
<style>${CLUB_BASE_CSS}${WALLET_CSS}${TOPUP_CSS}</style></head><body><main class="w">
<div class="top"><p class="kick">${h(t.title)}</p><a class="link" id="lang" href="${h(`${base}?lang=${t.other.code}`)}" lang="${t.other.code}" hreflang="${t.other.code}">${h(t.other.label)}</a></div>
<section class="hero" aria-labelledby="balanceLabel">
<p id="balanceLabel">${h(t.balance)}</p>
<p class="balance num" id="balance" aria-live="polite">${h(eur(state.balanceCents, t.locale))}</p>
<p class="status" id="notice" role="status" hidden></p>
</section>
${proof ? paidProofSection(lang, proof, options.now ?? new Date()) : ''}${proof && gw ? googleWalletSection(lang) : ''}${topUpBox(lang)}<section class="card main" id="faceCard" hidden aria-labelledby="faceTitle">
<h2 id="faceTitle"></h2><p id="faceWhy"></p>
<button class="btn" type="button" id="faceOn"></button>
<p class="err" id="faceErr" role="alert" hidden></p>
</section>
<section class="card how" id="howCard" hidden><p class="how" id="howText"></p></section>
<section class="card main" id="refundCard" hidden aria-labelledby="refundTitle">
<h2 id="refundTitle"></h2>
<ol class="steps" id="steps">${t.steps.map((s, i) => `<li data-i="${i}">${h(s)}</li>`).join('')}</ol>
<p id="refundHow"></p>
</section>
<nav class="more" id="more" aria-label="${h(t.more)}" hidden>
<button class="row" type="button" id="pinOpen" hidden>${h(t.pinRow)}<small>${h(t.pinRowHint)}</small></button>
<button class="row" type="button" id="mergeOpen" hidden>${h(t.mergeRow)}<small>${h(t.mergeRowHint)}</small></button>
<button class="row" type="button" id="leaveOpen" hidden>${h(t.leaveRow)}<small>${h(t.leaveRowHint)}</small></button>
</nav>
${gw && !proof ? googleWalletSection(lang) : ''}<section class="card" id="codeCard"><p class="kick">${h(t.codeTitle)}</p><p class="code num" id="code">${h(state.code)}</p><p class="small">${h(t.codeHint)}</p></section>
<section class="card"><h2 class="kick">${h(t.movements)}</h2><ul id="movements"></ul></section>
<p class="small">${h(t.saveHint)}</p>
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
${topUpSheet(lang, topUp)}<p class="toast" id="toast" role="status" hidden></p>
<script>
${PASSKEY_BROWSER_JS}
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
['faceOn','leaveGo','pinGo','mergeGo'].forEach(function(id){$(id).setAttribute('data-label',$(id).textContent);});
$('faceTitle').textContent=U.title;$('faceWhy').textContent=T.unlockWhy;$('faceOn').textContent=U.button;$('faceOn').setAttribute('data-label',U.button);
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
function render(s){S=s;S.cards=s.cards||[];
 $('balance').textContent=eur(s.balanceCents);$('code').textContent=s.code;
 var active=s.status==='ACTIVE',r=s.refund;
 var notice=active?'':s.status==='DEPLETED'?(s.merged?T.merged:T.depleted):r?'':T.closed;
 show('notice',notice);
 $('codeCard').hidden=!active;
 $('refundCard').hidden=!r;if(r)refundView(r);
 var canKey=pkSupported();
 $('faceCard').hidden=!(active&&!r&&!s.hasFaceId&&canKey);
 var how=s.hasFaceId?'✓ '+U.done+' '+T.unlockAfter:(active&&!r&&!canKey?T.unlockUnsupported:'');
 show('howText',how);$('howCard').hidden=!how||!!r;
 $('pinOpen').hidden=!(active&&!r&&!s.hasPin);
 $('mergeOpen').hidden=!(active&&!r&&!s.hasFaceId&&!s.merged&&s.balanceCents>0);
 $('leaveOpen').hidden=!(active&&s.balanceCents>0&&!s.closeRequested);
 $('more').hidden=$('pinOpen').hidden&&$('mergeOpen').hidden&&$('leaveOpen').hidden;
 if(gw)gw.hidden=!(P==='android'&&active&&!r&&!s.merged);
 var ul=$('movements');ul.textContent='';
 if(!s.movements.length){var e=document.createElement('li');e.className='mv';e.textContent=T.noMovements;ul.appendChild(e);}
 s.movements.forEach(function(m){var li=document.createElement('li'),a=document.createElement('span'),b=document.createElement('span');li.className='mv';
  a.textContent=[m.label,m.venueName,when(m.at)].filter(Boolean).join(' · ');
  b.textContent=(m.amountCents>0?'+':'')+eur(m.amountCents);b.className=(m.amountCents>0?'plus':'minus')+' num';
  li.appendChild(a);li.appendChild(b);ul.appendChild(li);});
 topRender(s);}
function post(path,body){return pkPost(C.base+path,body||{});}
function refresh(){if(busy)return;fetch(C.base+'/state',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(s){if(s&&!busy)render(s);}).catch(function(){});}
function msg(e){return (e&&e.message&&e.message!=='Error')?e.message:T.error;}
$('faceOn').addEventListener('click',function(){var b=$('faceOn');if(busy)return;busy=true;busyBtn(b,true,T.unlockWaiting);show('faceErr','');
 pkCreate(C.base+'/passkey/options').then(function(k){return post('/passkey',{response:k});})
  .then(function(s){render(s);toast('✓ '+U.done);}).catch(function(e){if(!pkCancelled(e))show('faceErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('leaveOpen').addEventListener('click',function(){
 $('leaveTitle').textContent=fill(T.leaveTitle,'amount',eur(S.balanceCents));
 $('leaveHow').textContent=S.cards.length?fill(T.leaveWaysCards,'cards',cards()):T.leaveWays;
 show('leaveErr','');openSheet($('leaveSheet'));});
$('leaveGo').addEventListener('click',function(){var b=$('leaveGo');if(busy)return;busy=true;busyBtn(b,true,T.sending);show('leaveErr','');
 post('/close').then(function(s){render(s);closeSheet($('leaveSheet'));toast(T.leaveDone);}).catch(function(e){show('leaveErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('pinOpen').addEventListener('click',function(){$('pin1').value='';$('pin2').value='';show('pinErr','');openSheet($('pinSheet'));$('pin1').focus();});
$('pinForm').addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;show('pinErr','');
 var a=$('pin1').value,c=$('pin2').value;
 if(!/^[0-9]{4}$/.test(a)){show('pinErr',T.pinFormat);return;}
 if(a!==c){show('pinErr',T.pinMismatch);return;}
 var b=$('pinGo');busy=true;busyBtn(b,true,T.sending);
 post('/pin',{pin:a,pin2:c}).then(function(s){render(s);closeSheet($('pinSheet'));toast(T.pinDone);})
  .catch(function(e){$('pin1').value='';$('pin2').value='';show('pinErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('mergeOpen').addEventListener('click',function(){show('mergeErr','');openSheet($('mergeSheet'));});
$('mergeGo').addEventListener('click',function(){var b=$('mergeGo');if(busy)return;busy=true;busyBtn(b,true,T.unlockWaiting);show('mergeErr','');
 pkGet(C.base+'/merge/challenge').then(function(k){return post('/merge',{response:k});})
  .then(function(r){closeSheet($('mergeSheet'));toast(fill(T.mergeDone,'amount',eur(r.balanceCents)));busy=false;refresh();})
  .catch(function(e){if(!pkCancelled(e))show('mergeErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});${gw ? GOOGLE_WALLET_JS : ''}
${TOPUP_JS}
render(S);
if(C.paid){try{history.replaceState(null,'',C.base+'?lang='+C.lang);}catch(e){}}
if(location.hash==='#sumar'&&!$('mergeOpen').hidden)openSheet($('mergeSheet'));
setInterval(function(){if(document.visibilityState==='visible')refresh();},3000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')refresh();});
})();
${proof ? paidProofScript(lang) : ''}
</script></body></html>`;
}
