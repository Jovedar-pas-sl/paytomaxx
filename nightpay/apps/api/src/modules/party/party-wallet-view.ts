import { escapeHtml } from '../payments/club-ui';
import { langMenu } from '../payments/customer-chrome';
import type { PayLanguage } from '../payments/pay-i18n';
import type { PartyPageData } from './party-refunds.service';
import { PARTY_WALLET_TEXT, type PartyWalletText } from './party-wallet-text';

/**
 * La página de la pulsera con OxioParty: la del saldo (wallets/wallet-page.ts)
 * con estas piezas encima (maqueta «Asistente · mi pulsera» y «Lo que sobra»):
 *  - tema claro de día (fondo crema, superficies blancas, tinta y lima en el
 *    saldo y en el botón principal; coral solo en el punto de la marca);
 *  - arriba la marca (BRAND_NAME u «OxioParty») y la fiesta;
 *  - el saldo grande en la tarjeta oscura con el número de la pulsera y los días;
 *  - tres botones: Recargar (el «Recargar» de siempre), «Lo que sobra» y «La perdí»;
 *  - los movimientos con el nombre de la caseta; las devoluciones hechas, también;
 *  - abajo, el plazo («pídelo hasta el …», venues.refundDeadline).
 * «Lo que sobra» y «La perdí» son hojas dentro de la página (nada de
 * confirm()/alert()). Contraste de 4,5:1 como mínimo en todo el texto.
 *
 * El JS va dentro de plantillas de TypeScript: sin barras invertidas. Todo
 * texto dinámico, con textContent.
 */

export const PARTY_THEME_COLOR = '#F3F1EC';

/** Las fichas de diseño de día y lo que cambia de la página del saldo. */
export const PARTY_CSS = `
:root{--bg:#F3F1EC;--surface:#FFFFFF;--surface-2:#FFFFFF;--surface-3:#EEEAE2;--line:#E0DBD1;--line-hi:#8C96A0;--fg:#14181B;--label:#3F474E;--mute:#3F474E;--dim:#5C656D;--ink-0:#FFFFFF;--paid:#E2F1E8;--paid-ink:#14181B;--fail:#B0341A;--warn:#8A5A00;--err:#A8341A;--bad:#B0341A;--ok:#1F7A4D;--stale:#EEEAE2;--scrim:rgb(20 24 27/.45);--sh-sheet:0 -12px 32px rgb(20 24 27/.18);--sh-dialog:0 16px 40px -12px rgb(20 24 27/.28);--coral:#FF7A59;--night:#14181B;--night-2:#B8C0C6;--night-fg:#F4F2EC;color-scheme:light}
.btn{background:var(--night);border-color:var(--night);color:var(--lime)}
.btn.alt{background:var(--surface);color:var(--fg);border-color:var(--line-hi)}
.err{background:#FFF4F0}
.top .pbrand{display:flex;align-items:center;gap:.375rem;margin:0;font-family:var(--num);font-size:1.25rem;font-weight:700;letter-spacing:-.02em;color:var(--fg)}
.top .pbrand i{width:.5rem;height:.5rem;border-radius:50%;background:var(--coral)}
.top .pside{display:flex;align-items:center;gap:.25rem;min-width:0}
.top .pchip{max-width:11rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:2rem;padding:.3rem .75rem;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--mute);font-size:.8125rem;font-weight:600}
.hero{background:var(--night);border-color:var(--night);color:var(--night-fg);padding:1.125rem 1.125rem 1rem}
#balanceLabel{color:var(--night-2);font-size:.8125rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.hero .balance{color:var(--lime);font-weight:700;letter-spacing:-.03em}
.hero .status{color:var(--night-fg)}
.hero .obot{margin-top:.25rem;padding-top:.75rem;border-top:1px dashed #3A4148;color:var(--night-2);font-weight:500}
.hero .obot #heroCode{color:var(--night-fg);font-weight:700}
.pacts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}
.pact{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.375rem;min-height:4.75rem;padding:.5rem .25rem;border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--fg);font:inherit;font-size:.875rem;font-weight:700;line-height:1.15;text-align:center;cursor:pointer;transition:transform .15s var(--ease)}
.pact svg{width:1.375rem;height:1.375rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pact.main{background:var(--night);border-color:var(--night);color:var(--night-fg)}
.pact.main svg{color:var(--lime)}
.pact:active{transform:scale(.98)}
.pact:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.pref ul{display:flex;flex-direction:column;gap:.25rem}
.pref li{color:var(--fg);font-weight:500}
.pnote{font-size:.8125rem;line-height:1.45;color:var(--dim);text-align:center}
li.mv .sw.prf{background:var(--dim)}
dialog.sheet.full{inset:0;width:100%;max-width:30rem;height:100%;max-height:none;margin:0 auto;border:0;border-radius:0;padding:calc(1rem + env(safe-area-inset-top)) 1rem calc(1.25rem + env(safe-area-inset-bottom));background:var(--bg);text-align:left;gap:.875rem}
dialog.sheet.full h2{font-family:var(--num);font-size:1.875rem;font-weight:700;letter-spacing:-.02em;line-height:1.05}
.sbx{display:flex;flex-direction:column;gap:.875rem;flex:1}
.sbx .link.back{align-self:flex-start;padding:0;min-height:2.75rem;color:var(--fg);font-weight:600;text-decoration:none;gap:.375rem}
.sbx .link.back svg{width:1.25rem;height:1.25rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sbamt{margin-top:.25rem;font-family:var(--num);font-size:3.25rem;font-weight:700;letter-spacing:-.03em;line-height:1;color:var(--fg)}
.sbwhy{margin-top:.5rem;color:var(--mute);font-size:.9375rem;line-height:1.4}
.sbwhy strong{color:var(--fg)}
.opts{border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:.5rem}
.opt{position:relative;display:flex;align-items:center;gap:.875rem;padding:.875rem 1rem;border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--fg);cursor:pointer}
.opt input{position:absolute;opacity:0;width:1px;height:1px}
.opt .dot{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--line-hi);background:var(--surface)}
.opt.on{border:2px solid var(--fg);padding:calc(.875rem - 1px) calc(1rem - 1px)}
.opt.on .dot{border:7px solid var(--fg)}
.opt:focus-within{outline:3px solid var(--fg);outline-offset:2px}
.opt .ot{display:flex;flex-direction:column;gap:.125rem;min-width:0}
.opt b{font-size:1.0625rem;font-weight:700;color:var(--fg)}
.opt small{font-size:.875rem;line-height:1.35;color:var(--dim)}
.opt .oamt{margin-left:auto;font-weight:700;color:var(--fg);white-space:nowrap}
.field{display:flex;flex-direction:column;gap:.375rem}
.field label{font-size:.875rem;font-weight:600;color:var(--mute)}
.field input{min-height:3.25rem;padding:0 .875rem;border:1.5px solid var(--line-hi);border-radius:12px;background:var(--surface);color:var(--fg);font:inherit;font-size:1rem}
.field input:focus-visible{outline:3px solid var(--fg);outline-offset:1px}
.sbx .grow{flex:1}
.sbok{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;text-align:center}
.sbok svg{width:7.5rem;height:7.5rem}
.sbok .okt{font-family:var(--num);font-size:2.25rem;font-weight:700;line-height:1.05;color:var(--fg)}
.sbok p{font-size:1.0625rem;line-height:1.45;color:var(--mute)}
#pLostSheet{text-align:left}
#pLostSheet h2{text-align:left}
#pLostSheet .code{font-size:1.5rem;letter-spacing:.12em;text-align:left}
`;

const TOPUP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const SOBRA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const LOST_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const OK_ICON =
  '<svg viewBox="0 0 168 168" fill="none" aria-hidden="true"><circle cx="84" cy="84" r="74" stroke="#14181B" stroke-width="8"/><path d="M52 86 L74 108 L118 62" stroke="#A8341A" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Arriba: la marca con su punto, la fiesta y el idioma. */
export function partyTopBar(lang: PayLanguage, data: Pick<PartyPageData, 'brand' | 'venueName'>): string {
  const h = escapeHtml;
  const chip = data.venueName ? `<span class="pchip">${h(data.venueName)}</span>` : '';
  return `<header class="top"><p class="pbrand">${h(data.brand)}<i aria-hidden="true"></i></p><div class="pside">${chip}${langMenu(lang)}</div></header>`;
}

/** Los tres botones debajo del saldo y la tarjeta de la devolución pedida. */
export function partyActions(lang: PayLanguage): string {
  const t = PARTY_WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<nav class="pacts" aria-label="${h(t.actions)}">
<button class="pact main" type="button" id="pTop">${TOPUP_ICON}<span>${h(t.topUp)}</span></button>
<button class="pact" type="button" id="pSobra">${SOBRA_ICON}<span>${h(t.sobra)}</span></button>
<button class="pact" type="button" id="pLost">${LOST_ICON}<span>${h(t.lost)}</span></button>
</nav>
<section class="card pref" id="pRefund" hidden aria-labelledby="pRefundT"><h2 class="sub" id="pRefundT">${h(t.pendingTitle)}</h2><ul id="pRefundList"></ul><p class="small" id="pRefundLock" hidden></p></section>
`;
}

/** Abajo: el plazo (lo escribe el JS con la fecha en el idioma de la página). */
export function partyNote(): string {
  return '<p class="pnote" id="pNote"></p>\n';
}

/** «Lo que sobra» (pantalla entera) y «La perdí». */
export function partySheets(lang: PayLanguage): string {
  const t = PARTY_WALLET_TEXT[lang];
  const h = escapeHtml;
  const opt = (k: 'CARD' | 'TRANSFER' | 'DONATE', title: string, note: string) =>
    `<label class="opt" id="opt${k}" hidden><input type="radio" name="sobraHow" value="${k}"><span class="dot" aria-hidden="true"></span><span class="ot"><b>${h(title)}</b><small>${h(note)}</small></span><span class="oamt num" id="opt${k}Amt"></span></label>`;
  return `<dialog class="sheet full" id="sobraSheet" aria-labelledby="sobraTitle">
<div class="sbx" id="sobraForm">
<button class="link back" type="button" data-close>${BACK_ICON}${h(t.back)}</button>
<div><h2 id="sobraTitle">${h(t.sobraTitle)}</h2><p class="sbamt num" id="sobraAmt"></p><p class="sbwhy" id="sobraWhy"></p></div>
<fieldset class="opts" id="sobraOpts"><legend class="sr">${h(t.how)}</legend>
${opt('CARD', t.card, t.cardNote)}
${opt('TRANSFER', t.transfer, t.transferNote)}
${opt('DONATE', t.donate, t.donateNote)}
</fieldset>
<div class="field" id="ibanBox" hidden><label for="sobraIban">${h(t.iban)}</label><input id="sobraIban" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" maxlength="42" placeholder="ES00 0000 0000 0000 0000 0000"></div>
<div class="field"><label for="sobraMail">${h(t.mail)}</label><input id="sobraMail" type="email" autocomplete="email" maxlength="254" placeholder="nombre@correo.com"></div>
<p class="err" id="sobraErr" role="alert" hidden></p>
<span class="grow"></span>
<button class="btn" type="button" id="sobraGo"></button>
</div>
<div class="sbx" id="sobraNone" hidden>
<button class="link back" type="button" data-close>${BACK_ICON}${h(t.back)}</button>
<h2>${h(t.sobraTitle)}</h2><p class="sbwhy" id="sobraNoneT" role="status"></p>
</div>
<div class="sbx" id="sobraOk" hidden>
<div class="sbok" role="status">${OK_ICON}<p class="okt" id="sobraOkT"></p><p id="sobraOkX"></p></div>
<button class="btn alt" type="button" data-close>${h(t.okBack)}</button>
</div>
</dialog>
<dialog class="sheet" id="pLostSheet" aria-labelledby="pLostTitle">
<h2 id="pLostTitle">${h(t.lostTitle)}</h2><p>${h(t.lostText)}</p>
<p>${h(t.lostCode)}</p><p class="code num" id="pLostCode"></p>
<button class="btn alt" type="button" id="pLostNow" hidden>${h(t.lostNow)}</button>
<button class="btn" type="button" data-close>${h(t.lostOk)}</button>
</dialog>
`;
}

/** Lo que lee el JS: la fiesta, «Lo que sobra» y sus textos. */
export function partyJsConfig(lang: PayLanguage, data: PartyPageData): PartyPageData & { text: PartyWalletText } {
  return { ...data, text: PARTY_WALLET_TEXT[lang] };
}

/**
 * Lo que hace la página con OxioParty. Lo usa wallet-page.ts (define $, T,
 * S, C, busy, fill, show, toast, eur, when, openSheet, closeSheet, busyBtn,
 * withKey, msg, refresh, setView, topCan y eurPay de TOPUP_JS):
 *  - mvText(m,a,sub): la fila de un movimiento (la caseta delante);
 *  - partyRender(s): tras cada render: la pulsera y los días en el saldo,
 *    sin «Me voy» (aquí es «Lo que sobra»), la devolución pedida y el plazo.
 */
export const PARTY_JS = `
var P=C.party,PT=P.text,SB={m:null};
function pDay(d){try{return new Date(d+'T12:00:00Z').toLocaleDateString(C.locale,{day:'numeric',month:'long',timeZone:'UTC'});}catch(e){return d;}}
function pRange(a,b){if(!a)return '';try{var f=new Intl.DateTimeFormat(C.locale,{day:'numeric',month:'long',timeZone:'Europe/Madrid'}),x=new Date(a);
 if(!b)return f.format(x);var y=new Date(b);return f.formatRange?f.formatRange(x,y):f.format(x)+' – '+f.format(y);}catch(e){return '';}}
function pErr(e){var k=e&&e.code;if(k==='REFUND_INVALID')return e.reason==='iban'?PT.ibanBad:e.reason==='email'?PT.mailBad:PT.err.REFUND_INVALID;
 if(k&&Object.prototype.hasOwnProperty.call(PT.err,k))return PT.err[k];return msg(e);}
function ibanOk(v){if(!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(v))return false;var r=v.slice(4)+v.slice(0,4),m=0;
 for(var i=0;i<r.length;i++){var c=r.charCodeAt(i),d=c>=65?c-55:c-48;m=(d>9?m*100+d:m*10+d)%97;}return m===1;}
function mvText(m,a,sub){var what=m.labelKey&&T.mv[m.labelKey]?T.mv[m.labelKey]:m.label;
 a.textContent=m.stallName||what;sub.textContent=[m.returned?T.detail.returned:'',m.stallName?what:'',m.ref,when(m.at)].filter(Boolean).join(' · ');}
function pReq(q){return q.method==='TRANSFER'?fill(fill(PT.reqTransfer,'amount',eurPay(q.amountCents)),'iban',q.ibanHint||''):q.method==='CARD'?fill(PT.reqCard,'amount',eurPay(q.amountCents)):eurPay(q.amountCents);}
function pNote(){var R=P.refund;$('pNote').textContent=!R.deadline?PT.noteOpen:R.open?fill(PT.noteUntil,'date',pDay(R.deadline)):fill(PT.noteClosed,'date',pDay(R.deadline));}
function pRefundRender(){var R=P.refund,list=$('pRefundList'),pend=R.requests.filter(function(q){return q.status==='PENDING';});
 list.textContent='';pend.forEach(function(q){var li=document.createElement('li');li.textContent=pReq(q)+' · '+PT.reqPending;list.appendChild(li);});
 $('pRefund').hidden=!pend.length;show('pRefundLock',R.locked?PT.pendingLocked:'');}
function pDoneRows(){var ul=$('movements'),done=P.refund.requests.filter(function(q){return q.status==='DONE';});if(!done.length)return;
 if(!S.movements.length)ul.textContent='';
 done.slice().reverse().forEach(function(q){var li=document.createElement('li'),sw=document.createElement('i'),mt=document.createElement('span'),a=document.createElement('b'),sub=document.createElement('span'),b=document.createElement('span');
  li.className='mv';sw.className='sw prf';sw.setAttribute('aria-hidden','true');mt.className='mt';
  a.textContent=q.method==='CARD'?PT.mvCard:q.method==='TRANSFER'?PT.mvTransfer:PT.mvDonate;sub.textContent=when(q.doneAt||q.createdAt);
  b.className='minus num';b.textContent=eur(-q.amountCents);mt.appendChild(a);mt.appendChild(sub);li.appendChild(sw);li.appendChild(mt);li.appendChild(b);ul.insertBefore(li,ul.firstChild);});}
function partyRender(s){$('balanceLabel').textContent=PT.balance;
 $('heroCode').textContent=s.pulsera?fill(PT.pulsera,'n',s.pulsera):s.code;$('heroFicha').textContent=pRange(P.eventStartsAt,P.eventEndsAt);
 $('leaveOpen').hidden=true;$('lostOpen').hidden=true;$('lostAsk').hidden=true;
 pRefundRender();pDoneRows();pNote();}
function sbAvail(){var A=P.refund.available;return ['CARD','TRANSFER','DONATE'].filter(function(k){return A[k]>0;});}
function sbMark(){Array.prototype.forEach.call(document.querySelectorAll('input[name=sobraHow]'),function(r){r.checked=r.value===SB.m;r.parentNode.classList.toggle('on',r.checked);});}
function sbShow(w){$('sobraForm').hidden=w!=='form';$('sobraNone').hidden=w!=='none';$('sobraOk').hidden=w!=='ok';}
function sbUpd(){var A=P.refund.available,c=SB.m?A[SB.m]:0,b=$('sobraGo'),label=fill(SB.m==='DONATE'?PT.give:PT.ask,'amount',eurPay(c));
 $('ibanBox').hidden=SB.m!=='TRANSFER';b.setAttribute('data-label',label);if(!busy)b.textContent=label;}
function sbWhy(){var R=P.refund,p=$('sobraWhy');p.textContent='';
 if(S.pulsera)p.appendChild(document.createTextNode(fill(PT.pulsera,'n',S.pulsera)+'. '));
 if(R.deadline){var parts=PT.sobraUntil.split('{date}'),st=document.createElement('strong');st.textContent=pDay(R.deadline);
  p.appendChild(document.createTextNode(parts[0]));p.appendChild(st);p.appendChild(document.createTextNode((parts[1]||'')+' '));}
 p.appendChild(document.createTextNode(PT.noFees));}
function sbFill(){var R=P.refund,A=R.available,ks=sbAvail();
 if(!R.open){$('sobraNoneT').textContent=fill(PT.closed,'date',pDay(R.deadline));sbShow('none');return;}
 if(!ks.length){$('sobraNoneT').textContent=R.locked?PT.nothingPending:PT.nothing;sbShow('none');return;}
 ['CARD','TRANSFER','DONATE'].forEach(function(k){$('opt'+k).hidden=!(A[k]>0);$('opt'+k+'Amt').textContent=A[k]>0?eurPay(A[k]):'';});
 if(!SB.m||!(A[SB.m]>0))SB.m=ks[0];
 $('sobraAmt').textContent=eurPay(Math.max(A.CARD+A.TRANSFER,A.DONATE));sbWhy();sbMark();sbUpd();sbShow('form');}
function sbLoad(){return fetch(C.base+'/sobra',{headers:{Accept:'application/json'}}).then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json();})
 .then(function(v){P.refund=v;pRefundRender();pNote();if($('sobraSheet').open&&$('sobraOk').hidden&&!busy)sbFill();}).catch(function(){});}
$('pSobra').addEventListener('click',function(){show('sobraErr','');sbFill();openSheet($('sobraSheet'));sbLoad();});
$('sobraOpts').addEventListener('change',function(e){var r=e.target;if(!r||r.name!=='sobraHow')return;SB.m=r.value;sbMark();show('sobraErr','');sbUpd();if(SB.m==='TRANSFER')$('sobraIban').focus();});
$('sobraGo').addEventListener('click',function(){var b=$('sobraGo');if(busy||!SB.m)return;show('sobraErr','');
 var m=SB.m,c=P.refund.available[m],body={method:m,expectedAmountCents:c},mail=$('sobraMail').value.trim();
 if(m==='TRANSFER'){var ib=$('sobraIban').value.toUpperCase().replace(/[^A-Z0-9]/g,'');if(!ibanOk(ib)){show('sobraErr',PT.ibanBad);$('sobraIban').focus();return;}body.iban=ib;}
 if(mail){if(!/^[^@ ]+@[^@ ]+[.][^@ ]+$/.test(mail)){show('sobraErr',PT.mailBad);$('sobraMail').focus();return;}body.email=mail;}
 if(S.hasFaceId&&!pkSupported()){show('sobraErr',T.faceIdNeeded);return;}
 busy=true;busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.sending);
 withKey('/sobra',body).then(function(v){P.refund=v;var give=m==='DONATE';
   $('sobraOkT').textContent=give?PT.thanksTitle:PT.okTitle;
   $('sobraOkX').textContent=fill(give?PT.thanksText:mail?PT.okTextMail:PT.okText,'amount',eurPay(c));
   $('sobraIban').value='';sbShow('ok');busy=false;busyBtn(b,false);refresh();})
  .catch(function(e){busy=false;busyBtn(b,false);if(!pkCancelled(e))show('sobraErr',pErr(e));if(e&&(e.code==='REFUND_AMOUNT_CHANGED'||e.code==='REFUND_METHOD_UNAVAILABLE'))sbLoad();});});
$('pTop').addEventListener('click',function(){if(topCan(S)){setView('top',true);$('seg').scrollIntoView({block:'start'});}else toast(P.refund.locked?PT.topUpLocked:T.topUpOff);});
$('pLost').addEventListener('click',function(){$('pLostCode').textContent=S.code;
 $('pLostNow').hidden=!(S.hasCard&&S.hasFaceId&&!S.merged&&!S.refund);openSheet($('pLostSheet'));});
$('pLostNow').addEventListener('click',function(){closeSheet($('pLostSheet'));$('lostOpen').click();});`;
