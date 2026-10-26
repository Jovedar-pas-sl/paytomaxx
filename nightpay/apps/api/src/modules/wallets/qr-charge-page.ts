import { BRAND_NAME } from '../../common/brand';
import { CLUB_BASE_CSS, MONEY_JS, brandBar, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { PAID_SCREEN_CSS, PAID_SCREEN_JS, paidScreenJsText, renderPaidScreen } from '../payments/paid-screen';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import { CLIENT_ERROR_JS, clientErrorConfig } from './client-errors';
import type { QrChargeClientView } from './wallet-charges.service';

/**
 * Página que abre el cliente al escanear el QR del cobro del personal:
 * "Te cobran 60 € · Masaje" → pagar con su saldo desbloqueando su móvil
 * (Face ID, huella o el PIN del teléfono). Al pagar, el mismo «Pagado» a
 * pantalla completa que el pago con tarjeta, con «Te quedan X €» (lima solo
 * en la respuesta de SU pago). Si se abre un cobro ya pagado (aunque sea
 * recién pagado: el QR de la chica en otro móvil), «Ya pagado · hace…» en
 * gris. Texto dinámico con textContent.
 */

const TEXT: Record<
  PayLanguage,
  {
    title: string;
    youPay: string;
    pay: string;
    paying: string;
    left: string;
    expired: string;
    notPending: string;
    /** Cobro único: ya lo pagó con tarjeta. */
    paidByCard: string;
    notFromBalance: string;
    askStaff: string;
    unsupported: string;
    unknown: string;
    /** Mientras pregunta al servidor si se cobró. */
    checking: string;
    /** El servidor dice que sigue pendiente: se puede volver a pagar. */
    stillPending: string;
    reload: string;
    expiresIn: string;
    other: { code: PayLanguage; label: string };
  }
> = {
  es: {
    title: `Pagar con tu saldo ${BRAND_NAME}`,
    youPay: 'Te cobran',
    pay: 'Pagar con mi saldo',
    paying: 'Desbloquea tu móvil…',
    left: 'Te quedan',
    expired: 'Este cobro ha caducado',
    notPending: 'Este cobro ya no está pendiente',
    paidByCard: 'Ya está pagado con tarjeta',
    notFromBalance: 'De tu saldo no se ha cobrado nada.',
    askStaff: 'Pide al personal que lo repita.',
    unsupported: 'Tu móvil no puede pagar así: di tu código al personal y teclea tu PIN en su móvil.',
    unknown: 'No sabemos si se ha cobrado. Vuelve a cargar la página antes de pagar otra vez.',
    checking: 'Comprobando si se ha cobrado…',
    stillPending: 'Este cobro sigue sin pagar: puedes volver a intentarlo.',
    reload: 'Volver a cargar',
    expiresIn: 'Caduca en',
    other: { code: 'en', label: 'English' },
  },
  en: {
    title: `Pay with your ${BRAND_NAME} balance`,
    youPay: 'You are paying',
    pay: 'Pay with my balance',
    paying: 'Unlock your phone…',
    left: 'Remaining',
    expired: 'This charge has expired',
    notPending: 'This charge is no longer pending',
    paidByCard: 'Already paid by card',
    notFromBalance: 'Nothing was taken from your balance.',
    askStaff: 'Ask the staff to repeat it.',
    unsupported: 'Your phone cannot pay this way: tell the staff your code and type your PIN on their phone.',
    unknown: 'We do not know whether it was charged. Reload the page before paying again.',
    checking: 'Checking whether it was charged…',
    stillPending: 'This charge is still unpaid: you can try again.',
    reload: 'Reload',
    expiresIn: 'Expires in',
    other: { code: 'es', label: 'Español' },
  },
};

const QR_CSS = `
.c{max-width:26rem;margin:0 auto;min-height:100vh;min-height:100svh;padding:4.25rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.9rem;text-align:center}
.amount{font-size:clamp(3rem,16vw,4.25rem);font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--fg)}
.who{color:var(--fg)}
.small{font-size:.9rem}
.safe{display:flex;align-items:center;gap:.5rem;padding:.55rem .9rem;border-radius:999px;background:var(--lime-soft);border:1.5px solid var(--lime-edge);color:var(--fg);font-weight:800}
.hint{width:100%;padding:.9rem 1rem;border:1px solid var(--line);border-radius:var(--r-tile);background:var(--surface);color:var(--fg);font-weight:700;text-align:left}
.after{max-width:26rem;margin:0 auto;padding:1rem;display:flex;flex-direction:column;align-items:center}
`;

/**
 * Qué se enseña si el pago con el saldo falla (`e` es el error de pkPost):
 *  - 'unknown': sin respuesta, 408 o 429 (de un proxy, un reintento…) o fallo
 *    del servidor (5xx). El cobro pudo hacerse y fallar después (p. ej. al leer
 *    el saldo que queda): no se sabe si se cobró. Ni «No se te ha cobrado
 *    nada» ni «Pagar» a ciegas: la página pregunta el estado (/state).
 *  - 'reload': 409 (ya no está pendiente, ya pagado, otro intento…): recargar
 *    enseña el estado real, sin el botón de pagar.
 *  - 'notCharged': otro 4xx: rechazado antes de cobrar (Face ID, pausa…).
 */
export const PAY_FAIL_JS =
  "function npPayFail(e){var s=e&&e.status;if(!s||s>=500||s===408||s===429)return 'unknown';return s===409?'reload':'notCharged';}";

/** Veces que la página pregunta el estado tras un fallo que no se sabe si cobró, y la espera entre una y otra. */
const STATE_TRIES = 3;
const STATE_RETRY_MS = 1500;

export function renderQrChargePage(
  token: string,
  lang: PayLanguage,
  view: QrChargeClientView,
  now: Date = new Date(),
): string {
  const t = TEXT[lang];
  const p = PAY_TEXT[lang];
  const h = escapeHtml;
  const base = `/s/${encodeURIComponent(token)}`;
  const locale = p.locale;
  const eur = (c: number): string => clientMoney(c, locale);
  const isPaid = view.status === 'ACCEPTED';
  const paidAt = isPaid && view.paidAt ? new Date(view.paidAt) : null;
  // El código del cobro único nunca va en la página antes de pagar (ni en el
  // HTML ni aquí): un «Pagado» falso no lo tendría. Al pagar aquí, llega en la
  // respuesta del pago.
  const { code, ...publicView } = view;
  const config = jsConfig({
    base,
    locale,
    text: { ...t, paid: paidScreenJsText(p), paidTitle: p.paidTitle, codeLabel: p.codeLabel, codeHint: p.codeHint },
    errors: clientErrorConfig(lang),
    view: publicView,
    // La hora del servidor: la cuenta atrás corrige la del móvil (como /pay).
    now: now.getTime(),
  });
  const who = [view.serviceName, view.requestedByName, view.venueName].filter(Boolean).join(' · ');
  // Ya pagado (alguien vuelve a abrir el QR): el «Pagado» en gris, sin formulario.
  const screen = renderPaidScreen({
    t: p,
    amount: isPaid ? eur(view.amountCents) : '',
    authorizedAt: paidAt,
    now,
    // Ya pagado: el mismo código que ve el personal en su PAGADO (el del cobro único); sin él, ninguno.
    code: isPaid ? (code ?? null) : null,
    hidden: !isPaid,
    fromBalance: true,
  });
  // Caducado, cancelado o rechazado: no se cobró nada.
  const closed = view.status !== 'PENDING' && !isPaid;
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0f1112"><title>${h(t.title)}</title>
<style>${CLUB_BASE_CSS}${QR_CSS}${PAID_SCREEN_CSS}</style></head><body>
${screen}
<main class="${isPaid ? 'after' : 'c'}" id="ask">
${isPaid ? '' : brandBar()}
${
  isPaid
    ? ''
    : closed && view.paidElsewhere
    ? `<p class="kick">${h(t.title)}</p>
<h1>${h(t.paidByCard)}</h1>
<p class="safe">${h(t.notFromBalance)}</p>`
    : closed
    ? `<p class="kick">${h(t.title)}</p>
<h1>${h(view.status === 'EXPIRED' ? t.expired : t.notPending)}</h1>
<p class="safe">${h(p.notCharged)}</p>
<p class="hint">${h(t.askStaff)}</p>`
    : `<p class="kick">${h(t.title)}</p>
<p>${h(t.youPay)}</p>
<h1 class="amount num">${h(eur(view.amountCents))}</h1>
${who ? `<p class="who">${h(who)}</p>` : ''}
<button class="btn" type="button" id="pay">${h(t.pay)}</button>
<p class="err" id="error" role="alert" hidden></p>
<p class="safe" id="notCharged" hidden>${h(p.notCharged)}</p>
<button class="btn alt" type="button" id="reload" hidden>${h(t.reload)}</button>
<p class="small num" id="clock" aria-hidden="true"></p>`
}
<a class="link" href="${h(`${base}?lang=${t.other.code}`)}" lang="${t.other.code}" hreflang="${t.other.code}">${h(t.other.label)}</a>
</main>
<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
${PAID_SCREEN_JS}
${PAY_FAIL_JS}
(function(){
var C=JSON.parse(${config}),T=C.text,V=C.view,el=document.getElementById('paid');
function $(id){return document.getElementById(id);}
${MONEY_JS}
function eur(c){return npMoney(c,C.locale,'EUR');}
function show(id,text){$(id).textContent=text;$(id).hidden=!text;}
if(!el.hidden){npPaid(el,T.paid);return;}
if(V.status!=='PENDING')return;
// Un móvil con la hora mal no da el cobro por caducado antes de tiempo (ni después).
var skew=(+C.now||Date.now())-Date.now(),over=false,exp=new Date(V.expiresAt).getTime(),iv;
function stop(text){over=true;clearInterval(iv);$('pay').hidden=true;$('clock').textContent='';if(text)show('error',text);}
function tick(){var s=Math.max(0,Math.floor((exp-Date.now()-skew)/1000));
 $('clock').textContent=over?'':T.expiresIn+' '+Math.floor(s/60)+':'+('0'+s%60).slice(-2);
 if(s<=0&&!over)stop(T.expired+'. '+T.askStaff);}
if(!pkSupported()){stop(T.unsupported);return;}
iv=setInterval(tick,1000);tick();
// Face ID preparado ya: al tocar "Pagar" sale al momento.
var go=pkPrepare(C.base+'/challenge');
function paid(r){stop('');$('ask').hidden=true;
 var t=Date.now();el.setAttribute('data-at',String(t));el.setAttribute('data-now',String(t));el.classList.remove('stale');
 el.querySelector('[data-title]').textContent=T.paidTitle;el.querySelector('[data-amount]').textContent=eur(r.amountCents);
 var line=document.createElement('p');line.className='pline';line.textContent=T.left+': '+eur(r.balanceCents);el.querySelector('[data-lines]').appendChild(line);
 if(r.code){var box=document.createElement('div');box.className='pcode';
  var lab=document.createElement('span');lab.textContent=T.codeLabel;var val=document.createElement('b');val.className='num';val.textContent=r.code;
  var hint=document.createElement('small');hint.textContent=T.codeHint;box.appendChild(lab);box.appendChild(val);box.appendChild(hint);
  el.insertBefore(box,el.querySelector('.pstale'));}
 el.hidden=false;window.scrollTo(0,0);npPaid(el,T.paid);}
// No se sabe si se cobró: se pregunta el estado. Pendiente → se puede volver a
// pagar; si no, recargar enseña lo que pasó; sin respuesta, «Volver a cargar».
function lost(){show('error',T.unknown);$('reload').hidden=false;$('pay').hidden=true;}
function check(n){
 fetch(C.base+'/state',{cache:'no-store',headers:{Accept:'application/json'}})
  .then(function(r){if(!r.ok)throw r;return r.json();})
  .then(function(s){if(!s||!s.status)throw s;
   if(s.status!=='PENDING'){location.reload();return;}
   if(!over){show('error',T.stillPending);$('pay').hidden=false;}})
  .catch(function(){if(n>1)setTimeout(function(){check(n-1);},${STATE_RETRY_MS});else lost();});
}
$('pay').addEventListener('click',function(){
 var b=$('pay');if(b.disabled)return;b.disabled=true;b.textContent=T.paying;show('error','');$('notCharged').hidden=true;$('reload').hidden=true;
 var k=go?go():pkGet(C.base+'/challenge');go=null;
 k.then(function(k){return pkPost(C.base+'/pay',{response:k});})
  // Un 200 sin lo cobrado (un proxy que contesta otra cosa) no es un «Pagado».
  .then(function(r){if(!r||typeof r.amountCents!=='number')throw new Error('?');paid(r);})
  .catch(function(e){b.disabled=false;b.textContent=T.pay;if(pkCancelled(e))return;
   var k=npPayFail(e);
   if(k==='unknown'){$('pay').hidden=true;show('error',T.checking);check(${STATE_TRIES});return;}
   show('error',npErr(e,C.errors));
   // 409: puede que un intento anterior sí se cobrara; recargar enseña el estado real.
   if(k==='reload'){$('reload').hidden=false;$('pay').hidden=true;}else $('notCharged').hidden=false;});
});
$('reload').addEventListener('click',function(){location.reload();});
})();
</script></body></html>`;
}
