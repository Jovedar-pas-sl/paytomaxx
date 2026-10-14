import { BRAND_NAME } from '../../common/brand';
import type { PayLanguage } from '../payments/pay-i18n';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import type { QrChargeClientView } from './wallet-charges.service';

/**
 * Página que abre el cliente al escanear el QR del cobro de la chica:
 * "Te cobran 60 € · Masaje" → pagar con su saldo desbloqueando su móvil
 * (Face ID, huella o el PIN del teléfono). Texto dinámico con textContent.
 */

const TEXT: Record<PayLanguage, {
  title: string;
  youPay: string;
  pay: string;
  paying: string;
  paid: string;
  left: string;
  expired: string;
  notPending: string;
  unsupported: string;
  noKey: string;
  expiresIn: string;
  other: { code: PayLanguage; label: string };
}> = {
  es: {
    title: `Pagar con tu saldo ${BRAND_NAME}`,
    youPay: 'Te cobran',
    pay: 'Pagar con mi saldo',
    paying: 'Desbloquea tu móvil…',
    paid: '✓ Pagado con tu saldo',
    left: 'Te quedan',
    expired: 'Este cobro ha caducado: pide a la chica que lo repita.',
    notPending: 'Este cobro ya no está pendiente.',
    unsupported: 'Tu móvil no puede pagar así. Pídeselo al encargado.',
    noKey: 'Primero activa Face ID en la página de tu recarga.',
    expiresIn: 'Caduca en',
    other: { code: 'en', label: 'English' },
  },
  en: {
    title: `Pay with your ${BRAND_NAME} balance`,
    youPay: 'You are paying',
    pay: 'Pay with my balance',
    paying: 'Unlock your phone…',
    paid: '✓ Paid with your balance',
    left: 'Remaining',
    expired: 'This charge has expired: ask the staff to repeat it.',
    notPending: 'This charge is no longer pending.',
    unsupported: 'Your phone cannot pay this way. Ask the manager.',
    noKey: 'First turn on Face ID on your top-up page.',
    expiresIn: 'Expires in',
    other: { code: 'es', label: 'Español' },
  },
};

function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c');
}

export function renderQrChargePage(token: string, lang: PayLanguage, view: QrChargeClientView): string {
  const t = TEXT[lang];
  const base = `/s/${encodeURIComponent(token)}`;
  const config = jsString(JSON.stringify({ base, locale: lang === 'en' ? 'en-GB' : 'es-ES', text: t, view }));
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0b0b"><title>${t.title}</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:1.5rem 1rem 2rem;background:#0b0b0b;color:#f5f5f0;font-size:18px}
main{max-width:26rem;margin:0 auto;display:flex;flex-direction:column;gap:1rem;text-align:center}
p{margin:0;color:#b4b4ac;line-height:1.45}
.kick{font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8a8a83}
.amount{font-size:3.2rem;font-weight:800;letter-spacing:-.03em;color:#f5f5f0}
.who{color:#f5f5f0}
button{font:inherit;font-weight:800;font-size:1.15rem;border-radius:12px;padding:1.1rem;cursor:pointer;border:2px solid #d4ff3a;background:#d4ff3a;color:#0b0b0b;width:100%}
button:disabled{opacity:.55}
.ok{font-size:1.4rem;font-weight:800;color:#5be38f}
.err{color:#ff6b6b}
.lang{color:#d4ff3a;font-weight:700;text-decoration:none}
[hidden]{display:none!important}
</style></head><body><main>
<p class="kick" id="title"></p>
<p id="youPay"></p>
<div class="amount" id="amount"></div>
<p class="who" id="who"></p>
<button id="pay"></button>
<p class="ok" id="done" hidden></p>
<p id="left" hidden></p>
<p class="err" id="error" role="alert" hidden></p>
<p id="clock"></p>
<a class="lang" id="lang"></a>
</main>
<script>
${PASSKEY_BROWSER_JS}
(function(){
var C=JSON.parse(${config}),T=C.text,V=C.view;
function $(id){return document.getElementById(id);}
function eur(c){return (c/100).toLocaleString(C.locale,{style:'currency',currency:'EUR'});}
function show(id,text){$(id).textContent=text;$(id).hidden=!text;}
$('title').textContent=T.title;$('youPay').textContent=T.youPay;$('amount').textContent=eur(V.amountCents);
$('who').textContent=[V.serviceName,V.requestedByName,V.venueName].filter(Boolean).join(' · ');
$('pay').textContent=T.pay;$('lang').textContent=T.other.label;$('lang').href=C.base+'?lang='+T.other.code;
var over=V.status!=='PENDING';
if(over){$('pay').hidden=true;show('error',V.status==='EXPIRED'?T.expired:T.notPending);}
else if(!pkSupported()){$('pay').hidden=true;show('error',T.unsupported);}
var exp=new Date(V.expiresAt).getTime(),iv=setInterval(function(){var s=Math.max(0,Math.floor((exp-Date.now())/1000));
  $('clock').textContent=over?'':T.expiresIn+' '+Math.floor(s/60)+':'+('0'+s%60).slice(-2);
  if(s<=0&&!over){over=true;clearInterval(iv);$('pay').hidden=true;show('error',T.expired);}},1000);
$('pay').addEventListener('click',function(){
  var b=$('pay');b.disabled=true;b.textContent=T.paying;show('error','');
  pkGet(C.base+'/challenge').then(function(k){return pkPost(C.base+'/pay',{response:k});})
   .then(function(r){over=true;clearInterval(iv);b.hidden=true;$('clock').textContent='';
     show('done',T.paid);show('left',T.left+': '+eur(r.balanceCents));})
   .catch(function(e){b.disabled=false;b.textContent=T.pay;if(!pkCancelled(e))show('error',(e&&e.message)||T.noKey);});
});
})();
</script></body></html>`;
}
