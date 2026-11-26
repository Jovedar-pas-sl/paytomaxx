import { CLUB_BASE_CSS, MONEY_JS, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, langScript, topBar } from '../payments/customer-chrome';
import { legalFooter } from '../legal/legal-links';
import { CUSTOMER_TEXT } from '../payments/i18n';
import { PAID_SCREEN_CSS, PAID_SCREEN_JS, paidScreenJsText, renderPaidScreen } from '../payments/paid-screen';
import { LOCK_ICON, TIP_JS } from '../payments/pay-choose-page';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import { CLIENT_ERROR_JS, clientErrorConfig } from './client-errors';
import { MY_BALANCE_TEXT, myBalanceButton, myBalanceScript } from './my-balance';
import { SALDO_TIP_CSS, SALDO_TIP_LINE, initialSaldoTip, saldoTipConfig, saldoTipFieldset } from './saldo-tip';
import type { QrChargeClientView } from './wallet-charges.service';

/**
 * Página que abre el cliente al escanear el QR del cobro del personal:
 * "Te cobran 60 € · Masaje" → pagar con su saldo desbloqueando su móvil
 * (Face ID, huella o el PIN del teléfono). Al pagar, el mismo «Pagado» a
 * pantalla completa que el pago con tarjeta (con el código enorme), con «Te
 * quedan X €» (lima solo en la respuesta de SU pago). Si se abre un cobro ya
 * pagado (aunque sea recién pagado: el QR en otro móvil), «Ya pagado ·
 * hace…» en gris. Texto dinámico con textContent. Textos: payments/i18n.
 */

const QR_CSS = `
.c{max-width:26rem;margin:0 auto;min-height:calc(100vh - 3.5rem);min-height:calc(100svh - 3.5rem);padding:1rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.9rem;text-align:center}
.c h1{font-size:1.75rem}
.amount{font-weight:600;letter-spacing:-.02em;line-height:1.05;color:var(--fg);font-variant-numeric:proportional-nums}
.c h1.amount{font-size:clamp(2.75rem,14vw,3.5rem)}
.who{color:var(--mute)}
.small{font-size:.875rem}
.safe{display:flex;align-items:center;gap:.5rem;padding:.625rem .875rem;border-radius:var(--r-field);background:var(--surface-2);border:1px solid var(--line-hi);color:var(--fg);font-weight:500}
.hint{width:100%;padding:.875rem 1rem;border:1px solid var(--line);border-radius:var(--r-tile);background:var(--surface);color:var(--fg);font-weight:500;text-align:left}
.after{max-width:26rem;margin:0 auto;padding:1rem;display:flex;flex-direction:column;align-items:center}
.secure{display:flex;align-items:center;gap:.4rem;font-size:.8125rem;color:var(--dim)}
.secure svg{width:1rem;height:1rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mine{width:100%;max-width:22rem;display:grid;gap:.5rem;margin-top:.5rem}
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
  /** B1: la propina que ya eligió en /pay antes de tocar «Pagar con mi saldo» (?tip=). */
  opts: { tipFromPay?: number | null } = {},
): string {
  const t = CUSTOMER_TEXT[lang].saldo;
  const p = PAY_TEXT[lang];
  const h = escapeHtml;
  const base = `/s/${encodeURIComponent(token)}`;
  const locale = p.locale;
  const eur = (c: number): string => clientMoney(c, locale);
  const isPaid = view.status === 'ACCEPTED';
  const paidAt = isPaid && view.paidAt ? new Date(view.paidAt) : null;
  // B1: la propina la elige aquí el cliente (sin nada marcado), si el cobro la admite.
  const tipView = view.status === 'PENDING' ? (view.tip ?? null) : null;
  const initialTip = tipView ? initialSaldoTip(tipView, opts.tipFromPay ?? null) : null;
  const dueCents = tipView ? tipView.baseCents + (initialTip ?? 0) : view.amountCents;
  const tipLine = (tip: number): string =>
    tipView ? SALDO_TIP_LINE[lang].split('{base}').join(eur(tipView.baseCents)).split('{tip}').join(eur(tip)) : '';
  // El código del cobro único nunca va en la página antes de pagar (ni en el
  // HTML ni aquí): un «Pagado» falso no lo tendría. Al pagar aquí, llega en la
  // respuesta del pago.
  const { code, ...publicView } = view;
  const config = jsConfig({
    base,
    lang,
    locale,
    text: {
      ...t,
      paid: paidScreenJsText(p),
      paidTitle: p.paidTitle,
      codeLabel: p.codeLabel,
      codeHint: p.codeHint,
    },
    errors: clientErrorConfig(lang),
    view: publicView,
    tip: tipView ? saldoTipConfig(lang, tipView) : null,
    // La hora del servidor: la cuenta atrás corrige la del móvil (como /pay).
    now: now.getTime(),
  });
  // A nombre de una compañera (cobro por el encargado): «Servicio con Nerea», en su idioma.
  const by = view.served && view.requestedByName ? p.serviceWith(view.requestedByName) : view.requestedByName;
  const who = [view.serviceName, by, view.venueName].filter(Boolean).join(' · ');
  // Caducado, cancelado o rechazado: no se cobró nada.
  const closed = view.status !== 'PENDING' && !isPaid;
  // «Ver mi saldo»: tras pagar aquí, el enlace que trae la respuesta del pago;
  // al abrir uno ya pagado o cerrado, con Face ID (la página no sabe de quién es).
  const mine = `<div class="mine"><a class="btn alt" id="mineLink" hidden>${h(MY_BALANCE_TEXT[lang].button)}</a>${myBalanceButton(lang)}</div>`;
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
    footer: closed ? undefined : mine,
  });
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#091518"><title>${h(t.title)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${QR_CSS}${PAID_SCREEN_CSS}${tipView ? SALDO_TIP_CSS : ''}</style></head><body>
${topBar(lang, undefined, { over: isPaid })}
${screen}
<main class="${isPaid ? 'after' : 'c'}" id="ask">
${
  isPaid
    ? ''
    : closed && view.paidElsewhere
    ? `<p class="kick">${h(t.title)}</p>
<h1>${h(t.paidByCard)}</h1>
<p class="safe">${h(t.notFromBalance)}</p>
${mine}`
    : closed
    ? `<p class="kick">${h(t.title)}</p>
<h1>${h(view.status === 'EXPIRED' ? t.expired : t.notPending)}</h1>
<p class="safe">${h(p.notCharged)}</p>
<p class="hint">${h(t.askStaff)}</p>
${mine}`
    : `<p class="kick">${h(t.title)}</p>
<p>${h(t.youPay)}</p>
<h1 class="amount num" id="amt">${h(clientMoney(dueCents, locale, 'EUR', true))}</h1>
${tipView ? `<p class="tipline num" id="tipLine"${initialTip ? '' : ' hidden'}>${h(initialTip ? tipLine(initialTip) : '')}</p>` : ''}
${who ? `<p class="who">${h(who)}</p>` : ''}
${tipView ? saldoTipFieldset(lang, tipView, initialTip) : ''}
<button class="btn" type="button" id="pay">${h(t.pay)}</button>
<p class="err" id="error" role="alert" hidden></p>
<p class="safe" id="notCharged" hidden>${h(p.notCharged)}</p>
<button class="btn alt" type="button" id="reload" hidden>${h(t.reload)}</button>
<p class="small num" id="clock" aria-hidden="true"></p>
<p class="secure">${LOCK_ICON}${h(p.secure)}</p>`
}
</main>
<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
${PAID_SCREEN_JS}
${PAY_FAIL_JS}
${TIP_JS}
(function(){
var C=JSON.parse(${config}),T=C.text,V=C.view,TP=C.tip,el=document.getElementById('paid'),sentTip=null;
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
// B1: la propina que elige el cliente (sin nada marcado: «Sin propina»).
function tipNow(){if(!TP)return null;var r=document.querySelector('input[name=tip]:checked');if(!r)return {tip:0,error:null};
 if(r.id==='otherRadio'){var o=npTipOther($('otherIn').value,TP.max);return {tip:o.cents,error:o.error};}return {tip:+r.value||0,error:null};}
function tipErr(text){var e=$('otherErr');if(e){e.textContent=text;e.hidden=!text;}}
function tipShow(){if(!TP)return;var s=tipNow(),oth=$('otherRadio'),on=Boolean(oth&&oth.checked),box=$('otherBox'),t=s.error?0:s.tip,l=$('tipLine');
 if(box)box.hidden=!on;if(!on)tipErr('');$('amt').textContent=npMoney(TP.base+t,C.locale,'EUR',true);
 if(l){l.hidden=!(t>0);l.textContent=t>0?TP.line.split('{base}').join(eur(TP.base)).split('{tip}').join(eur(t)):'';}}
if(TP){document.querySelectorAll('input[name=tip]').forEach(function(r){r.addEventListener('change',function(){tipShow();if(r.id==='otherRadio')$('otherIn').focus();});});
 var oin=$('otherIn');if(oin)oin.addEventListener('input',function(){tipErr('');tipShow();});tipShow();}
if(!pkSupported()){stop(T.unsupported);return;}
iv=setInterval(tick,1000);tick();
// Face ID preparado ya: al tocar "Pagar" sale al momento.
var go=pkPrepare(C.base+'/challenge');
function paid(r){stop('');$('ask').hidden=true;
 var t=Date.now();el.setAttribute('data-at',String(t));el.setAttribute('data-now',String(t));el.classList.remove('stale');
 el.querySelector('[data-title]').textContent=T.paidTitle;el.querySelector('[data-amount]').textContent=eur(r.amountCents);
 if(typeof r.balanceCents==='number'){var line=document.createElement('p');line.className='pline';line.textContent=T.left.split('{amount}').join(eur(r.balanceCents));el.querySelector('[data-lines]').appendChild(line);}
 if(r.code){var box=document.createElement('div');box.className='pcode';
  var lab=document.createElement('span');lab.className='plabel';lab.textContent=T.codeLabel;var val=document.createElement('b');val.className='num';val.textContent=r.code;
  var hint=document.createElement('span');hint.className='phint';hint.textContent=T.codeHint;box.appendChild(lab);box.appendChild(val);box.appendChild(hint);
  el.insertBefore(box,el.querySelector('.pstale'));}
 // «Ver mi saldo»: el enlace de SU saldo (la respuesta del pago); sin él, con Face ID.
 var ml=$('mineLink');if(r.walletUrl&&/^[/]w[/][A-Za-z0-9_-]+$/.test(r.walletUrl)){ml.href=r.walletUrl+'?lang='+encodeURIComponent(C.lang);ml.hidden=false;}else if(window.npMineShow)window.npMineShow(true);
 var bar=document.querySelector?document.querySelector('header.top'):null;if(bar)bar.classList.add('over');
 el.hidden=false;window.scrollTo(0,0);npPaid(el,T.paid);}
// No se sabe si se cobró: se pregunta el estado. Pendiente → se puede volver a
// pagar; cobrado → el PAGADO de este pago (no el gris de un QR que se vuelve a
// abrir: lo acaba de pagar este móvil), con su código; si no, recargar enseña
// lo que pasó; sin respuesta, «Volver a cargar».
function lost(){show('error',T.unknown);$('reload').hidden=false;$('pay').hidden=true;}
function check(n){
 fetch(C.base+'/state',{cache:'no-store',headers:{Accept:'application/json'}})
  .then(function(r){if(!r.ok)throw r;return r.json();})
  .then(function(s){if(!s||!s.status)throw s;
   if(s.status==='ACCEPTED'){paid({amountCents:TP&&sentTip!==null?TP.base+sentTip:V.amountCents,code:s.code||null});return;}
   if(s.status!=='PENDING'){location.reload();return;}
   if(!over){show('error',T.stillPending);$('pay').hidden=false;}})
  .catch(function(){if(n>1)setTimeout(function(){check(n-1);},${STATE_RETRY_MS});else lost();});
}
$('pay').addEventListener('click',function(){
 var b=$('pay');if(b.disabled)return;
 // «Otra» sin importe o por encima del máximo: se dice antes de pedir Face ID.
 var tp=tipNow();if(tp&&tp.error){tipErr(tp.error==='max'?TP.tooHigh:TP.empty);$('otherIn').focus();return;}
 b.disabled=true;b.textContent=T.paying;show('error','');$('notCharged').hidden=true;$('reload').hidden=true;
 var k=go?go():pkGet(C.base+'/challenge');go=null;sentTip=tp?tp.tip:null;
 k.then(function(k){return pkPost(C.base+'/pay',tp?{response:k,tipCents:tp.tip}:{response:k});})
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
</script>
${myBalanceScript(lang, { visible: view.status !== 'PENDING' })}
${legalFooter(lang)}
${langScript()}</body></html>`;
}
