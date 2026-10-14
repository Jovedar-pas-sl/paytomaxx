import type { PayLanguage } from '../payments/pay-i18n';
import type { ClientWalletState } from './wallet-charges.service';
import { BRAND_NAME } from '../../common/brand';

/**
 * Página del saldo del cliente (/w/:token). HTML autocontenido, look "Club".
 * El estado se pinta en el navegador y se refresca cada pocos segundos: así le
 * aparece al momento el cobro que tiene que aceptar. Todo texto dinámico va
 * con textContent (nada de HTML inyectado).
 */

interface WalletText {
  htmlLang: PayLanguage;
  locale: string;
  title: string;
  balance: string;
  codeHint: string;
  saveHint: string;
  pendingTitle: string;
  accept: string;
  reject: string;
  movements: string;
  noMovements: string;
  leave: string;
  leaveConfirm: string;
  leaveRequested: string;
  closed: string;
  depleted: string;
  error: string;
  rememberHint: string;
  protectTitle: string;
  protectHint: string;
  protectButton: string;
  protectedNote: string;
  otherPhone: string;
  otherPhoneProtected: string;
  passkeyFailed: string;
  other: { code: PayLanguage; label: string };
}

const TEXT: Record<PayLanguage, WalletText> = {
  es: {
    htmlLang: 'es',
    locale: 'es-ES',
    title: `Tu saldo ${BRAND_NAME}`,
    balance: 'Saldo',
    codeHint: 'Enséñale este QR o el código a la chica para pagar con tu saldo',
    saveHint: 'Guarda esta página (Compartir → Añadir a pantalla de inicio) para volver a tu saldo.',
    pendingTitle: 'Te quieren cobrar',
    accept: 'Aceptar',
    reject: 'Rechazar',
    movements: 'Movimientos',
    noMovements: 'Aún no hay movimientos.',
    leave: 'Me voy: devolver mi saldo',
    leaveConfirm: '¿Pedir que te devuelvan el saldo que te queda?',
    leaveRequested: 'Has pedido que te devuelvan el saldo. Pasa por la barra o espera al encargado.',
    closed: 'Este saldo ya está cerrado.',
    depleted: 'Has gastado todo el saldo.',
    error: 'No se ha podido completar. Inténtalo otra vez.',
    rememberHint: 'Este móvil recuerda tu saldo: si cierras la página, escanea cualquier QR de pago del local y te lo enseñamos.',
    protectTitle: 'Protege tu saldo',
    protectHint: 'Con Face ID o tu huella, solo tú podrás aceptar cobros, aunque alguien vea tu enlace.',
    protectButton: 'Activar Face ID / huella',
    protectedNote: '🔒 Protegido con Face ID / huella',
    otherPhone: 'Este saldo está guardado en otro móvil.',
    otherPhoneProtected: 'Este saldo está en otro móvil y protegido: para aceptar cobros, usa ese móvil.',
    passkeyFailed: 'No se ha podido comprobar Face ID / huella. Inténtalo otra vez.',
    other: { code: 'en', label: 'English' },
  },
  en: {
    htmlLang: 'en',
    locale: 'en-GB',
    title: `Your ${BRAND_NAME} balance`,
    balance: 'Balance',
    codeHint: 'Show this QR or the code to the staff to pay with your balance',
    saveHint: 'Save this page (Share → Add to Home Screen) to come back to your balance.',
    pendingTitle: 'Payment request',
    accept: 'Accept',
    reject: 'Decline',
    movements: 'Activity',
    noMovements: 'No activity yet.',
    leave: "I'm leaving: refund my balance",
    leaveConfirm: 'Ask for your remaining balance to be refunded?',
    leaveRequested: 'You asked for your balance to be refunded. Go to the bar or wait for the manager.',
    closed: 'This balance is closed.',
    depleted: 'You have spent all your balance.',
    error: 'That did not work. Please try again.',
    rememberHint: 'This phone remembers your balance: if you close the page, scan any payment QR in the venue and we will show it.',
    protectTitle: 'Protect your balance',
    protectHint: 'With Face ID or your fingerprint, only you can accept charges, even if someone sees your link.',
    protectButton: 'Turn on Face ID / fingerprint',
    protectedNote: '🔒 Protected with Face ID / fingerprint',
    otherPhone: 'This balance is saved on another phone.',
    otherPhoneProtected: 'This balance is on another phone and protected: use that phone to accept charges.',
    passkeyFailed: 'Face ID / fingerprint could not be checked. Please try again.',
    other: { code: 'es', label: 'Español' },
  },
};

function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c');
}

/** Solo un <svg> generado aquí (qrcode): nada de scripts ni otras etiquetas. */
function safeQrSvg(svg: string | null | undefined): string {
  if (!svg) return '';
  const trimmed = svg.trim();
  if (!trimmed.startsWith('<svg') || /<script|<foreignObject|on\w+=/i.test(trimmed)) return '';
  return trimmed;
}

export function renderWalletPage(
  token: string,
  lang: PayLanguage,
  state: ClientWalletState,
  opts: { codeQrSvg?: string | null } = {},
): string {
  const qr = safeQrSvg(opts.codeQrSvg);
  const t = TEXT[lang];
  const base = `/w/${encodeURIComponent(token)}`;
  const config = jsString(JSON.stringify({ base, lang, locale: t.locale, text: t, state }));
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0b0b"><title>${t.title}</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:1.25rem 1rem 2rem;background:#0b0b0b;color:#f5f5f0;font-size:18px}
main{max-width:26rem;margin:0 auto;display:flex;flex-direction:column;gap:1rem}
p{margin:0;color:#b4b4ac;line-height:1.45}
.card{border:2px solid #2a2a2a;border-radius:14px;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.5rem}
.kick{font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8a8a83}
.balance{font-size:3rem;font-weight:800;letter-spacing:-.03em;line-height:1;color:#f5f5f0}
.qr{background:#fff;border-radius:12px;padding:10px;width:min(220px,70vw);margin:0 auto}
.qr svg{display:block;width:100%;height:auto}
.code{font-size:2.6rem;font-weight:800;letter-spacing:.2em;color:#d4ff3a;text-align:center;font-variant-numeric:tabular-nums}
.pending{border-color:#d4ff3a;background:#141a06}
.pending .amount{font-size:2.4rem;font-weight:800;color:#f5f5f0}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
button{font:inherit;font-weight:800;border-radius:10px;padding:1rem;cursor:pointer;border:2px solid #d4ff3a;background:#d4ff3a;color:#0b0b0b;width:100%}
button.alt{background:transparent;color:#f5f5f0;border-color:#3a3a3a}
button:disabled{opacity:.55}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
li{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid #2a2a2a;font-size:.95rem}
li span:first-child{color:#b4b4ac}
li .plus{color:#5be38f;font-weight:700}
li .minus{color:#f5f5f0;font-weight:700}
.note{border:2px solid #ffb020;border-radius:10px;padding:.75rem 1rem;color:#ffb020}
.lang{color:#d4ff3a;font-weight:700;text-decoration:none;text-align:center}
.ok{color:#5be38f;font-weight:700;text-align:center}
[hidden]{display:none!important}
</style></head><body><main>
<p class="kick" id="title"></p>
<section class="card"><p id="balanceLabel"></p><div class="balance" id="balance"></div></section>
<section class="card" id="codeCard">${qr ? `<div class="qr" aria-hidden="true">${qr}</div>` : ''}<div class="code" id="code"></div><p id="codeHint" style="text-align:center"></p></section>
<section class="card pending" id="pending" hidden>
  <p class="kick" id="pendingTitle"></p>
  <div class="amount" id="pendingAmount"></div>
  <p id="pendingWho"></p>
  <div class="row"><button class="alt" id="reject"></button><button id="accept"></button></div>
</section>
<p class="note" id="notice" hidden></p>
<p class="note" id="otherPhone" hidden></p>
<section class="card" id="protectCard" hidden><p class="kick" id="protectTitle"></p><p id="protectHint"></p><button id="protect"></button></section>
<p class="ok" id="protectedNote" hidden></p>
<section class="card"><p class="kick" id="movementsTitle"></p><ul id="movements"></ul></section>
<button class="alt" id="leave" hidden></button>
<p id="saveHint" style="font-size:.85rem"></p>
<a class="lang" id="lang"></a>
</main>
<script>
(function(){
var C=JSON.parse(${config}),T=C.text,busy=false,cur=C.state;
function $(id){return document.getElementById(id);}
function eur(c){return (c/100).toLocaleString(C.locale,{style:'currency',currency:'EUR'});}
function when(iso){return new Date(iso).toLocaleString(C.locale,{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
$('title').textContent=T.title;$('balanceLabel').textContent=T.balance;$('codeHint').textContent=T.codeHint;
$('pendingTitle').textContent=T.pendingTitle;$('accept').textContent=T.accept;$('reject').textContent=T.reject;
$('movementsTitle').textContent=T.movements;$('leave').textContent=T.leave;$('saveHint').textContent=T.saveHint;
$('lang').textContent=T.other.label;$('lang').href=C.base+'?lang='+T.other.code;
$('protectTitle').textContent=T.protectTitle;$('protectHint').textContent=T.protectHint;$('protect').textContent=T.protectButton;
$('protectedNote').textContent=T.protectedNote;
function render(s){
  cur=s;
  $('balance').textContent=eur(s.balanceCents);
  $('code').textContent=s.code;
  var active=s.status==='ACTIVE';
  $('codeCard').hidden=!active;
  var notice=!active?(s.status==='DEPLETED'?T.depleted:T.closed):(s.closeRequested?T.leaveRequested:'');
  $('notice').hidden=!notice;$('notice').textContent=notice;
  $('leave').hidden=!(active&&s.balanceCents>0&&!s.closeRequested);
  var d=s.device||{};
  $('protectCard').hidden=!(active&&d.thisPhone&&!d.protected&&!!window.PublicKeyCredential);
  $('protectedNote').hidden=!d.protected;
  $('otherPhone').hidden=!d.otherPhone;$('otherPhone').textContent=d.protected?T.otherPhoneProtected:T.otherPhone;
  $('saveHint').textContent=d.thisPhone?T.rememberHint:T.saveHint;
  var p=s.pending;$('pending').hidden=!p;
  if(p){$('pendingAmount').textContent=eur(p.amountCents);
    $('pendingWho').textContent=[p.serviceName,p.requestedByName,p.venueName].filter(Boolean).join(' · ');
    $('accept').dataset.id=p.id;$('reject').dataset.id=p.id;}
  var ul=$('movements');ul.textContent='';
  if(!s.movements.length){var e=document.createElement('li');e.textContent=T.noMovements;ul.appendChild(e);}
  s.movements.forEach(function(m){var li=document.createElement('li'),a=document.createElement('span'),b=document.createElement('span');
    a.textContent=[m.label,m.venueName,when(m.at)].filter(Boolean).join(' · ');
    b.textContent=(m.amountCents>0?'+':'')+eur(m.amountCents);b.className=m.amountCents>0?'plus':'minus';
    li.appendChild(a);li.appendChild(b);ul.appendChild(li);});
}
function dis(v){$('accept').disabled=$('reject').disabled=$('leave').disabled=$('protect').disabled=v;}
function api(path,body){return fetch(C.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
   .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.detail||j.message||T.error);return j;});});}
/* Face ID / huella (WebAuthn): el navegador habla en bytes, el API en base64url. */
function b64u(buf){var s='',b=new Uint8Array(buf);for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).split('+').join('-').split('/').join('_').split('=').join('');}
function bytes(s){s=s.split('-').join('+').split('_').join('/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}
function cancelled(e){return e&&(e.name==='NotAllowedError'||e.name==='AbortError');}
function createKey(){return api('/passkey/options').then(function(o){
  o.challenge=bytes(o.challenge);o.user.id=bytes(o.user.id);(o.excludeCredentials||[]).forEach(function(c){c.id=bytes(c.id);});
  return navigator.credentials.create({publicKey:o});
 }).then(function(c){var r=c.response;return api('/passkey',{response:{id:c.id,rawId:b64u(c.rawId),type:c.type,
  response:{clientDataJSON:b64u(r.clientDataJSON),attestationObject:b64u(r.attestationObject),transports:r.getTransports?r.getTransports():[]},
  authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults()}});});}
function getKey(){return api('/passkey/challenge').then(function(o){
  o.challenge=bytes(o.challenge);(o.allowCredentials||[]).forEach(function(c){c.id=bytes(c.id);});
  return navigator.credentials.get({publicKey:o});
 }).then(function(c){var r=c.response;return {id:c.id,rawId:b64u(c.rawId),type:c.type,
  response:{clientDataJSON:b64u(r.clientDataJSON),authenticatorData:b64u(r.authenticatorData),signature:b64u(r.signature),userHandle:r.userHandle?b64u(r.userHandle):undefined},
  authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults()};});}
/* Aceptar o irse: con el saldo protegido, primero la cara o el dedo. */
function post(path,needsKey){busy=true;dis(true);
  var key=needsKey&&cur.device&&cur.device.protected?getKey():Promise.resolve(undefined);
  return key.then(function(k){return api(path,k?{passkey:k}:{});})
   .then(render).catch(function(e){if(!cancelled(e))alert((e&&e.message)||T.error);refresh();})
   .finally(function(){busy=false;dis(false);});}
function refresh(){if(busy)return;fetch(C.base+'/state',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(s){if(s)render(s);}).catch(function(){});}
$('accept').addEventListener('click',function(){if(!busy)post('/requests/'+encodeURIComponent(this.dataset.id)+'/accept',true);});
$('reject').addEventListener('click',function(){if(!busy)post('/requests/'+encodeURIComponent(this.dataset.id)+'/reject',true);});
$('leave').addEventListener('click',function(){if(!busy&&confirm(T.leaveConfirm))post('/close',true);});
$('protect').addEventListener('click',function(){if(busy)return;busy=true;dis(true);
  createKey().then(render).catch(function(e){if(!cancelled(e))alert((e&&e.message)||T.passkeyFailed);})
   .finally(function(){busy=false;dis(false);});});
render(C.state);
/* Ya en un navegador de verdad: si el saldo aún no es de nadie, es de este móvil. */
var dv=C.state.device||{};if(!dv.thisPhone&&!dv.otherPhone)api('/claim').then(render).catch(function(){});
setInterval(function(){if(document.visibilityState==='visible')refresh();},3000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')refresh();});
})();
</script></body></html>`;
}

/** /w en un móvil sin saldo guardado. */
export function renderNoWalletPage(lang: PayLanguage): string {
  const t =
    lang === 'en'
      ? {
          title: `Your ${BRAND_NAME} balance`,
          line: 'There is no balance saved on this phone.',
          hint: 'Open the link to your balance (you got it when you topped up) or ask the staff.',
        }
      : {
          title: `Tu saldo ${BRAND_NAME}`,
          line: 'En este móvil no hay ningún saldo guardado.',
          hint: 'Abre el enlace de tu saldo (te lo dieron al recargar) o pídeselo al personal.',
        };
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0b0b"><title>${t.title}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:2rem 1rem;background:#0b0b0b;color:#f5f5f0;font-size:18px}
main{max-width:26rem;margin:0 auto;display:flex;flex-direction:column;gap:1rem}p{margin:0;color:#b4b4ac;line-height:1.45}
.kick{font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8a8a83}b{color:#f5f5f0}</style></head>
<body><main><p class="kick">${t.title}</p><p><b>${t.line}</b></p><p>${t.hint}</p></main></body></html>`;
}
