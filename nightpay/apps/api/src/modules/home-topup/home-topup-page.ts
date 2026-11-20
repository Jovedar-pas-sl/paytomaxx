import { CLUB_BASE_CSS, MONEY_JS, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, langHrefWith, topBar } from '../payments/customer-chrome';
import { legalConsent, legalFooter } from '../legal/legal-links';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { CARD_MARKS, LOCK_IC, PAY_MARKS_CSS } from '../payments/pay-marks';
import { CLIENT_ERROR_JS, clientErrorConfig } from '../wallets/client-errors';
import { MY_BALANCE_TEXT, myBalanceBlock } from '../wallets/my-balance';
import { PASSKEY_BROWSER_JS } from '../wallets/passkey-browser';
import { WALLET_TEXT } from '../wallets/wallet-text';
import { TOPUP_CSS, topUpFeeExplain } from '../wallets/wallet-topup-view';
import { HOME_TOPUP_TEXT } from './home-topup-text';
import { QUEUE_PAGE_TEXT } from './home-topup-queue';
import { GIFT_LEGAL_TEXT, GIFT_MESSAGE_MAX, GIFT_NAME_MAX, GIFT_PRESETS_CENTS, GIFT_UNCLAIMED_MAX_DAYS } from './home-topup-gift';
import type { HomeTopUpPageView } from './home-topup.service';

/**
 * La página del enlace del local (/r/<código>): «Cargar saldo antes de
 * llegar». Móvil primero, marca OxioCard (club-ui), en los cuatro idiomas.
 *  - Arriba, para qué es («Carga tu saldo para Sala Aurora»), la ventaja en
 *    una línea y cómo funciona en tres pasos cortos: elige cuánto, paga, y al
 *    llegar el móvil o (si el local da fichas) su QR en recepción.
 *  - Si este navegador ya tiene un saldo del local: «Recargar mi saldo» (va a
 *    su página del saldo, en «Recargar») antes de ofrecer uno nuevo.
 *  - Cuánto (las sugeridas, «Otra», de 10 a 300 € en euros enteros) y el
 *    total: con la comisión del servicio de las recargas, el desglose y el
 *    botón «Pagar 56 €» (la comisión la calcula el servidor: la tabla de
 *    cada importe va en la página, como en «Recargar»); sin ella, «Cargar 50 €».
 *  - Las condiciones antes de pagar: lo que no gaste no se pierde (no
 *    caduca) y la regla del saldo: no se devuelve, se queda para la próxima
 *    visita (decisión del dueño, 17-nov-2026).
 *  - Con «Regalos» encendido: «Para mí» / «Para regalar» (?regalo=1): 25, 50
 *    o 100 € u «Otro», su nombre y un mensaje (opcionales) y las condiciones
 *    del regalo; el botón va por POST /r/<código>/regalo.
 * El botón crea la carga (POST /r/<código>/topup) y lleva a la página de pago
 * de siempre (/pay/…): Apple Pay o Google Pay de entrada, o tarjeta.
 * Sin barras invertidas en el JS (va dentro de una plantilla).
 */

const HOME_CSS = `
.qnote{margin:.5rem 0 0;padding:.625rem .875rem;border-radius:var(--r-tile);border:1px solid var(--line-hi);background:var(--surface-2);color:var(--fg);font-weight:500}${TOPUP_CSS}
.h{max-width:26rem;margin:0 auto;padding:.25rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.hh{display:flex;flex-direction:column;gap:.375rem;padding:.5rem 0 .25rem}
.hh h1{font-size:1.75rem;color:var(--fg)}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1rem;display:flex;flex-direction:column;gap:.75rem;background:var(--surface)}
.card h2{font-size:1.125rem;line-height:1.25}
.card.mine{border-color:var(--line-hi)}
.card.off{border-color:var(--warn)}

.or{font-weight:500;color:var(--fg)}
.tsteps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem;counter-reset:np-step}
.tsteps li{display:grid;grid-template-columns:1.5rem 1fr;gap:.625rem;align-items:start;color:var(--mute);font-size:.9375rem;line-height:1.4;counter-increment:np-step}
.tsteps li::before{content:counter(np-step);display:grid;place-items:center;width:1.5rem;height:1.5rem;margin-top:-.0625rem;border:1px solid var(--line-hi);border-radius:50%;color:var(--fg);font-family:var(--num);font-size:.8125rem;font-weight:600;line-height:1}
.terms{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.75rem}
.terms li{display:grid;grid-template-columns:1.5rem 1fr;gap:.625rem;align-items:start;color:var(--mute);font-size:.875rem;line-height:1.45}
.terms li svg{width:1.25rem;height:1.25rem;margin-top:.05rem;fill:none;stroke:var(--mute);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.terms li b{color:var(--fg)}
.small{font-size:.875rem}
.foot{text-align:center}
.gchoice{display:grid;grid-template-columns:1fr 1fr;gap:.25rem;padding:.25rem;border:1px solid var(--line);border-radius:var(--r-btn);background:var(--surface)}
.gchoice a{display:flex;align-items:center;justify-content:center;min-height:2.75rem;border:1px solid transparent;border-radius:calc(var(--r-btn) - 4px);color:var(--mute);font-weight:500;text-decoration:none}
.gchoice a[aria-current=page]{background:var(--surface-2);border-color:var(--line-hi);color:var(--fg)}
.gfields{display:flex;flex-direction:column;gap:.375rem}
.gfields input,.gfields textarea{width:100%;min-height:2.75rem;padding:.625rem .75rem;border:1px solid var(--line-hi);border-radius:var(--r-tile);background:var(--surface-2);color:var(--fg);font:inherit;font-size:1rem;resize:none}
.topup .paybar{position:sticky;bottom:0;z-index:5;display:flex;flex-direction:column;gap:.5rem;margin:0 -1rem -1rem;padding:.75rem 1rem calc(.875rem + env(safe-area-inset-bottom));border-radius:0 0 var(--r) var(--r);background:var(--surface);text-align:center}
.topup .paybar::before{content:'';position:absolute;left:0;right:0;bottom:100%;height:.75rem;background:linear-gradient(to top,var(--surface),rgb(19 22 24/0));pointer-events:none}
.topup .paybar .btn{font-size:1.0625rem}
${PAY_MARKS_CSS}/* Móviles bajos (360×740): más compacto, para que el desglose con la comisión quede por encima de la barra de pagar. */
@media (max-height:780px){
.h{gap:.625rem}
.hh{gap:.25rem;padding-top:0}
.hh h1{font-size:1.375rem}
.hh p:last-child{font-size:.9375rem;line-height:1.4}
.tsteps{gap:.25rem}
.tsteps li{font-size:.875rem;line-height:1.35}
.tsteps li::before{width:1.25rem;height:1.25rem;margin-top:0;font-size:.75rem}
.amts span{min-height:2.75rem}
.tform{gap:.5rem}
}`;

/** Iconos de las condiciones (decorativos). */
const ICON = {
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  // «i»: la regla del saldo (antes, una flecha de devolver).
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
};

function eur(cents: number, locale: string): string {
  return clientMoney(cents, locale);
}

function fill(text: string, key: string, value: string): string {
  return text.split(`{${key}}`).join(value);
}

/** «Ya tienes un saldo aquí»: recargar ese en vez de crear otro. */
function mineCard(lang: PayLanguage, base: string, codeHint: string): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  return `<section class="card mine" aria-labelledby="mineTitle">
<h2 id="mineTitle">${h(t.mineTitle)}</h2>
<p>${h(fill(t.mineBody, 'code', codeHint))}</p>
<a class="btn" id="mineGo" href="${h(`${base}/mi-saldo?lang=${lang}`)}">${h(t.mineGo)}</a>
</section>
<p class="or">${h(t.mineOr)}</p>
`;
}

/**
 * Cuánto cargar: las sugeridas (la del medio, marcada), «Otra», los límites y
 * el total. El botón va en una barra fija abajo, y el error dentro de ella,
 * encima del botón: fuera de la barra quedaría tapado por ella.
 */
function amountCard(lang: PayLanguage, view: HomeTopUpPageView, gift: boolean): string {
  const t = HOME_TOPUP_TEXT[lang];
  const w = WALLET_TEXT[lang];
  const p = PAY_TEXT[lang];
  const h = escapeHtml;
  const presets = gift ? GIFT_PRESETS_CENTS : view.presetsCents;
  const middle = presets[Math.floor((presets.length - 1) / 2)];
  const radios = presets
    .map(
      (c) =>
        `<label><input type="radio" name="amt" value="${c}"${c === middle ? ' checked' : ''}><span class="num">${h(eur(c, w.locale))}</span></label>`,
    )
    .join('');
  const limits = fill(fill(w.topUpLimits, 'min', eur(view.minCents, w.locale)), 'max', eur(view.maxCents, w.locale));
  // Con un saldo recordado, la acción (lima) es «Recargar mi saldo»; un saldo nuevo, secundario: una sola lima (C-2).
  const feeBps = view.serviceFeeBps ?? 0;
  const pct = new Intl.NumberFormat(w.locale, { style: 'percent', maximumFractionDigits: 2 }).format(feeBps / 10_000);
  const breakdown =
    feeBps > 0
      ? `<dl class="brk" id="brk" aria-live="off">
<div><dt>${h(gift ? t.gift.choiceGift : t.toBalance)}</dt><dd class="num" id="bAmount"></dd></div>
<div class="fee"><dt>${h(p.breakdown.serviceFee)} <button class="why" type="button" id="whyBtn" aria-expanded="true" aria-controls="whyText">${h(p.feeWhat)}</button></dt><dd class="num" id="bFee"></dd><dd class="whytext" id="whyText">${h(topUpFeeExplain(lang, pct))}</dd></div>
<div class="tot"><dt>${h(p.totalToPay)}</dt><dd class="num" id="bTotal"></dd></div>
</dl>`
      : '';
  const legend = gift ? t.gift.amountLegend : t.amountLegend;
  // Para regalar: su nombre y un mensaje, opcionales y en texto plano (el servidor los limpia y la página los escapa).
  const giftFields = gift
    ? `<div class="gfields"><label for="gName">${h(t.gift.nameLabel)}</label><input id="gName" type="text" maxlength="${GIFT_NAME_MAX}" autocomplete="off">
<label for="gMsg">${h(t.gift.messageLabel)}</label><textarea id="gMsg" rows="2" maxlength="${GIFT_MESSAGE_MAX}"></textarea></div>
`
    : '';
  return `<section class="card topup" aria-labelledby="amtTitle">
<h2 id="amtTitle">${h(legend)}</h2>
<form id="f" class="tform" autocomplete="off" novalidate>
<fieldset><legend class="sr">${h(legend)}</legend><div class="amts">${radios}<label><input type="radio" name="amt" value="other" id="amtOther"><span>${h(w.topUpOther)}</span></label></div></fieldset>
<div class="tother" id="otherBox" hidden><label for="otherIn">${h(w.topUpOtherLabel)}</label>
<div class="teur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" aria-describedby="limits"><span aria-hidden="true">€</span></div></div>
<p class="small" id="limits">${h(limits)}</p>
${giftFields}${breakdown}
<div class="paybar"><p class="err" id="err" role="alert" hidden></p>
<button class="${view.mine && !gift ? 'btn alt' : 'btn'}" type="submit" id="go">${LOCK_IC}<span id="goLbl"></span></button>
${legalConsent(lang)}
<p class="small">${h(t.methods)}</p></div>
</form>
</section>
`;
}

/**
 * Cómo funciona, en tres pasos: elige cuánto, paga y, al llegar, el móvil o
 * (si el local da fichas) el QR de su saldo en recepción, que le da la ficha.
 */
function howSteps(lang: PayLanguage, fichas: boolean, gift: boolean): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  const steps = gift ? [t.gift.stepChoose, t.stepPay, t.gift.stepShare] : [t.stepChoose, t.stepPay, fichas ? t.stepArrive : t.stepArriveNoFicha];
  return `<ol class="tsteps" aria-label="${h(t.howTitle)}">${steps.map((s) => `<li>${h(s)}</li>`).join('')}</ol>
`;
}

/**
 * Lo que tiene que saber antes de pagar: lo que no gaste no se pierde y el
 * saldo no se devuelve (se queda para la próxima visita). Con o sin comisión,
 * lo mismo: nada se devuelve.
 */
function termsCard(lang: PayLanguage, giftVenue: string | null = null): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  // Para regalar: solo en este local, y lo que dirá el abogado (GIFT_LEGAL_TEXT).
  const gift = giftVenue === null ? '' : `${giftTerms(lang, giftVenue)}\n`;
  return `<section class="card" aria-labelledby="termsTitle">
<h2 id="termsTitle">${h(t.conditionsTitle)}</h2>
<ul class="terms">
${gift}<li>${ICON.clock}<span><b>${h(t.keep)}</b> ${h(t.noExpiry)}</span></li>
<li>${ICON.info}<span>${h(t.keepRule)}</span></li>
</ul>
</section>
`;
}

/** Las condiciones del regalo (también en «Comparte tu regalo»): solo en este local, no se devuelve y caduca sin guardar. */
export function giftTerms(lang: PayLanguage, venueName: string): string {
  const t = HOME_TOPUP_TEXT[lang].gift;
  const legal = GIFT_LEGAL_TEXT[lang];
  const h = escapeHtml;
  return [
    fill(t.onlyHere, 'venue', venueName),
    legal.notRefundable,
    fill(legal.unclaimedExpiry, 'days', String(GIFT_UNCLAIMED_MAX_DAYS)),
  ]
    .map((line) => `<li>${ICON.info}<span>${h(line)}</span></li>`)
    .join('\n');
}

/** «Para mí» / «Para regalar»: la misma página, con ?regalo=1 (solo con «Regalos» encendido). */
function giftChoice(lang: PayLanguage, base: string, gift: boolean): string {
  const t = HOME_TOPUP_TEXT[lang].gift;
  const h = escapeHtml;
  const link = (href: string, label: string, current: boolean) =>
    `<a href="${h(href)}"${current ? ' aria-current="page"' : ''}>${h(label)}</a>`;
  return `<nav class="gchoice" aria-label="${h(t.choiceLabel)}">${link(`${base}?lang=${lang}`, t.choiceMe, !gift)}${link(`${base}?lang=${lang}&regalo=1`, t.choiceGift, gift)}</nav>
`;
}

/**
 * Ahora el local no deja cargar (pausa, formas de cobro, pasarela): sin
 * formulario. Salida: «Ver mi saldo» (el que recuerda este navegador o, si
 * no, con su Face ID), donde también se recarga cuando el local vuelve a dejar.
 */
function offCard(lang: PayLanguage, base: string, remembered: boolean): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  const mine = remembered
    ? `<a class="btn alt" href="${h(`${base}/mi-saldo?lang=${lang}`)}">${h(MY_BALANCE_TEXT[lang].button)}</a>`
    : myBalanceBlock(lang, { withPasskeyJs: true });
  return `<section class="card off" role="status" aria-labelledby="offTitle">
<h2 id="offTitle">${h(t.offTitle)}</h2>
<p>${h(t.offBody)}</p>
${mine}
</section>
`;
}

/** Textos que necesita el JS. */
function jsText(lang: PayLanguage, gift: boolean): Record<string, string> {
  const t = HOME_TOPUP_TEXT[lang];
  const w = WALLET_TEXT[lang];
  return {
    go: gift ? t.gift.go : t.go,
    goFee: t.goFee,
    goPlain: t.title,
    opening: t.opening,
    range: w.topUpRange,
    error: w.error,
  };
}

/** El JS: el total del importe elegido, el botón y la carga (sin barras invertidas). */
export const HOME_JS = `
var K='';
function newKey(){var a=new Uint8Array(16);crypto.getRandomValues(a);K=pkB64u(a.buffer);}
function cents(){var r=$('f').querySelector('input[name=amt]:checked');if(!r)return 0;
 if(r.value!=='other')return +r.value||0;return (parseInt($('otherIn').value.replace(/[^0-9]/g,'')||'0',10)||0)*100;}
function ok(c){return c>=C.min&&c<=C.max&&c%100===0;}
function fee(c){var t=C.fees,f=t&&ok(c)?t[(c-C.min)/100]:0;return typeof f==='number'&&f>0?f:0;}
function label(c){if(!ok(c))return T.goPlain;var f=fee(c);return f>0?fill(T.goFee,'amount',eurP(c+f)):fill(T.go,'amount',eurP(c));}
function setGo(text,on){var b=$('go');b.disabled=on;b.classList.toggle('busy',on);$('goLbl').textContent=text;}
function upd(){var c=cents(),b=$('go'),l=label(c),bk=$('brk');$('otherBox').hidden=!$('amtOther').checked;
 b.setAttribute('data-label',l);if(!busy)$('goLbl').textContent=l;
 if(bk){var f=fee(c),good=ok(c);bk.hidden=!good;$('bAmount').textContent=good?eurP(c):'';$('bFee').textContent=good?eurP(f):'';$('bTotal').textContent=good?eurP(c+f):'';}}
var wb=$('whyBtn');if(wb){$('whyText').hidden=true;wb.setAttribute('aria-expanded','false');
 wb.addEventListener('click',function(){var o=wb.getAttribute('aria-expanded')!=='true';wb.setAttribute('aria-expanded',String(o));$('whyText').hidden=!o;});}
$('f').addEventListener('change',function(e){upd();if(e.target===$('amtOther')&&e.target.checked)$('otherIn').focus();});
$('otherIn').addEventListener('input',upd);
$('f').addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;show('err','');
 var c=cents(),b=$('go');
 if(!ok(c)){show('err',fill(fill(T.range,'min',eur(C.min)),'max',eur(C.max)));return;}
 busy=true;setGo(T.opening,true);
 (C.gift?pkPost(C.base+'/regalo',{amountCents:c,key:K,lang:C.lang,name:$('gName').value,message:$('gMsg').value})
  :pkPost(C.base+(C.queue?'/cola':'/topup'),C.queue?{amountCents:c,key:K,lang:C.lang,queue:C.queue}:{amountCents:c,key:K,lang:C.lang}))
  .then(function(r){var u=r&&r.payUrl;if(typeof u==='string'&&u.indexOf('/pay/')===0){location.href=u;return;}throw new Error(T.error);})
  .catch(function(e){newKey();busy=false;setGo(b.getAttribute('data-label'),false);show('err',npErr(e,C.errors));});});
window.addEventListener('pageshow',function(e){if(e.persisted){busy=false;newKey();setGo($('go').getAttribute('data-label'),false);}});
newKey();upd();`;

/**
 * `mode` 'gift' («Para regalar», ?regalo=1): solo con «Regalos» encendido;
 * apagado, la página de siempre sin la elección. Sin el cartel de la cola.
 */
export function renderHomeTopUpPage(code: string, lang: PayLanguage, view: HomeTopUpPageView, mode: 'load' | 'gift' = 'load'): string {
  const t = HOME_TOPUP_TEXT[lang];
  const w = WALLET_TEXT[lang];
  const h = escapeHtml;
  const base = `/r/${encodeURIComponent(code)}`;
  const canLoad = view.problem === null;
  const gift = mode === 'gift' && view.gifts === true;
  // El QR del cartel de la cola (B16): el de esta noche carga por /cola; uno de otra noche, aviso y lo de siempre.
  const q = QUEUE_PAGE_TEXT[lang];
  // Sin cookie del móvil (muchos móviles nuevos desde esta IP esta noche): lo dice y carga como el enlace de siempre.
  const noDevice = view.queue !== undefined && 'token' in view.queue && view.queue.noDevice === true;
  const queueToken = view.queue && 'token' in view.queue && !noDevice && !gift ? view.queue.token : null;
  // «Para regalar» no va por el cartel: sin su nota.
  const queueNote = gift
    ? ''
    : queueToken
      ? `<p class="qnote" role="note">${h(q.note)}</p>`
      : view.queue
        ? `<p class="qnote" role="status">${h(noDevice ? q.noDevice : q.expired)}</p>`
        : '';
  const config = jsConfig({
    base,
    lang,
    locale: w.locale,
    min: view.minCents,
    max: view.maxCents,
    fees: view.feesCents,
    text: jsText(lang, gift),
    errors: {
      ...clientErrorConfig(lang),
      ...t.errors,
      HOME_TOPUP_QUEUE_EXPIRED: q.expired,
      HOME_TOPUP_QUEUE_COOKIE: q.noCookies,
      HOME_TOPUP_QUEUE_DEVICE: q.deviceMax,
      HOME_TOPUP_QUEUE_NIGHT: q.nightMax,
      HOME_TOPUP_QUEUE_IP: q.ipMax,
      HOME_TOPUP_QUEUE_OPEN: q.open,
    },
    ...(queueToken ? { queue: queueToken } : {}),
    ...(gift ? { gift: true } : {}),
  });
  const venue = h(view.venueName);
  const heading = h(gift ? t.gift.heading : t.heading).split('{venue}').join(`<span>${venue}</span>`);
  const choice = view.gifts === true && canLoad ? giftChoice(lang, base, gift) : '';
  const loadParts = gift
    ? `${choice}${howSteps(lang, false, true)}${termsCard(lang, view.venueName)}${amountCard(lang, view, true)}`
    : `${choice}${howSteps(lang, view.fichas !== false, false)}${termsCard(lang)}${view.mine ? mineCard(lang, base, view.mine.codeHint) : ''}${amountCard(lang, view, false)}`;
  return `<!DOCTYPE html>
<html lang="${PAY_TEXT[lang].htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${h(`${t.title} · ${view.venueName}`)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${HOME_CSS}</style></head><body>
${topBar(lang, gift ? langHrefWith(base, { regalo: '1' }) : undefined)}
<main class="h">
<section class="hh" aria-labelledby="hTitle">
<h1 id="hTitle">${heading}</h1>
<p>${h(gift ? t.gift.advantage : t.advantage)}</p>
${queueNote}</section>
${
  /*
   * Las condiciones («Antes de pagar»), antes de las dos formas de cargar y
   * del botón (C-3); «O carga un saldo nuevo:» queda pegado al importe. Si no
   * se puede cargar, primero lo dice y después las condiciones.
   */ ''
}${canLoad ? loadParts : `${offCard(lang, base, Boolean(view.mine))}${termsCard(lang)}`}<p class="foot trust">${h(PAY_TEXT[lang].secure)}${CARD_MARKS}</p>
</main>
${
  canLoad
    ? `<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
(function(){
var C=JSON.parse(${config}),T=C.text,busy=false;
function $(id){return document.getElementById(id);}
${MONEY_JS}
function eur(c){return npMoney(c,C.locale,'EUR');}
function eurP(c){return npMoney(c,C.locale,'EUR',true);}
function fill(s,k,v){return s.split('{'+k+'}').join(v);}
function show(id,text){$(id).textContent=text||'';$(id).hidden=!text;}
${HOME_JS}
})();
${LANG_JS}
</script>`
    : `<script>${LANG_JS}</script>`
}
${legalFooter(lang)}
</body></html>`;
}

/** 404 sin pistas: no dice si el local existe, si lo apagó o si cambió el enlace. */
export function renderHomeTopUpGone(lang: PayLanguage): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  return `<!DOCTYPE html>
<html lang="${PAY_TEXT[lang].htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${h(t.notFoundTitle)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${HOME_CSS}</style></head><body>
${topBar(lang)}
<main class="h">
<section class="card off" aria-labelledby="goneTitle">
<h1 id="goneTitle" class="sub">${h(t.notFoundTitle)}</h1>
<p>${h(t.notFoundBody)}</p>
${/* Salida: su saldo con su Face ID (desde allí también se recarga). No dice nada del local. */ ''}${myBalanceBlock(lang, { withPasskeyJs: true })}
</section>
</main>
${legalFooter(lang)}
<script>${LANG_JS}</script>
</body></html>`;
}
