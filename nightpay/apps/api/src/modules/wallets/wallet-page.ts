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
<section class="card"><p class="kick" id="movementsTitle"></p><ul id="movements"></ul></section>
<button class="alt" id="leave" hidden></button>
<p id="saveHint" style="font-size:.85rem"></p>
<a class="lang" id="lang"></a>
</main>
<script>
(function(){
var C=JSON.parse(${config}),T=C.text,busy=false;
function $(id){return document.getElementById(id);}
function eur(c){return (c/100).toLocaleString(C.locale,{style:'currency',currency:'EUR'});}
function when(iso){return new Date(iso).toLocaleString(C.locale,{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
$('title').textContent=T.title;$('balanceLabel').textContent=T.balance;$('codeHint').textContent=T.codeHint;
$('pendingTitle').textContent=T.pendingTitle;$('accept').textContent=T.accept;$('reject').textContent=T.reject;
$('movementsTitle').textContent=T.movements;$('leave').textContent=T.leave;$('saveHint').textContent=T.saveHint;
$('lang').textContent=T.other.label;$('lang').href=C.base+'?lang='+T.other.code;
function render(s){
  $('balance').textContent=eur(s.balanceCents);
  $('code').textContent=s.code;
  var active=s.status==='ACTIVE';
  $('codeCard').hidden=!active;
  var notice=!active?(s.status==='DEPLETED'?T.depleted:T.closed):(s.closeRequested?T.leaveRequested:'');
  $('notice').hidden=!notice;$('notice').textContent=notice;
  $('leave').hidden=!(active&&s.balanceCents>0&&!s.closeRequested);
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
function post(path){busy=true;$('accept').disabled=$('reject').disabled=$('leave').disabled=true;
  return fetch(C.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
   .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.detail||j.message||T.error);return j;});})
   .then(render).catch(function(e){alert(e.message||T.error);refresh();})
   .finally(function(){busy=false;$('accept').disabled=$('reject').disabled=$('leave').disabled=false;});}
function refresh(){if(busy)return;fetch(C.base+'/state',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(s){if(s)render(s);}).catch(function(){});}
$('accept').addEventListener('click',function(){if(!busy)post('/requests/'+encodeURIComponent(this.dataset.id)+'/accept');});
$('reject').addEventListener('click',function(){if(!busy)post('/requests/'+encodeURIComponent(this.dataset.id)+'/reject');});
$('leave').addEventListener('click',function(){if(!busy&&confirm(T.leaveConfirm))post('/close');});
render(C.state);setInterval(function(){if(document.visibilityState==='visible')refresh();},3000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')refresh();});
})();
</script></body></html>`;
}
