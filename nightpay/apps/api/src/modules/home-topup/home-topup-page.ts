import { CLUB_BASE_CSS, MONEY_JS, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../payments/customer-chrome';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { CARD_MARKS, LOCK_IC, PAY_MARKS_CSS } from '../payments/pay-marks';
import { CLIENT_ERROR_JS, clientErrorConfig } from '../wallets/client-errors';
import { PASSKEY_BROWSER_JS } from '../wallets/passkey-browser';
import { WALLET_TEXT } from '../wallets/wallet-text';
import { TOPUP_CSS } from '../wallets/wallet-topup-view';
import { HOME_TOPUP_TEXT } from './home-topup-text';
import type { HomeTopUpPageView } from './home-topup.service';

/**
 * La página del enlace del local (/r/<código>): «Cargar saldo antes de
 * llegar». Móvil primero, marca OxioCard (club-ui), en los cuatro idiomas.
 *  - Arriba, para qué es («Carga tu saldo para Sala Aurora»).
 *  - Si este navegador ya tiene un saldo del local: «Recargar mi saldo» (va a
 *    su página del saldo, en «Recargar») antes de ofrecer uno nuevo.
 *  - Cuánto (las sugeridas, «Otra», de 10 a 300 € en euros enteros) y el
 *    total: con la comisión del servicio de las recargas, el desglose y el
 *    botón «Pagar 56 €» (la comisión la calcula el servidor: la tabla de
 *    cada importe va en la página, como en «Recargar»); sin ella, «Cargar 50 €».
 *  - Las condiciones antes de pagar: el saldo no caduca, cómo se pide la
 *    devolución (lo que hace hoy «Me voy») y, con comisión, que esa no se
 *    devuelve; y qué hacer al llegar.
 * El botón crea la carga (POST /r/<código>/topup) y lleva a la página de pago
 * de siempre (/pay/…): Apple Pay o Google Pay de entrada, o tarjeta.
 * Sin barras invertidas en el JS (va dentro de una plantilla).
 */

const HOME_CSS = `${TOPUP_CSS}
.h{max-width:26rem;margin:0 auto;padding:.25rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.hh{position:relative;isolation:isolate;overflow:hidden;padding:1.15rem 1.15rem 1.25rem;border-radius:24px;display:flex;flex-direction:column;gap:.55rem;background:var(--bits),linear-gradient(135deg,var(--green-1) 0%,var(--green-2) 55%,var(--green-3) 100%);box-shadow:0 0 0 1px var(--lime-edge),0 18px 40px -20px var(--lime-glow)}
.hh::after{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(118deg,transparent 38%,var(--lime-soft) 50%,transparent 62%);pointer-events:none}
.hh .kick{color:var(--lime)}
.hh h1{font-size:clamp(1.7rem,8.4vw,2.2rem);color:var(--cream);letter-spacing:-.02em}
.hh h1 span{color:var(--lime)}
.hh p{color:var(--cream)}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1.1rem;display:flex;flex-direction:column;gap:.75rem;background:var(--surface)}
.card h2{font-size:1.25rem;line-height:1.2}
.card.mine{border:1.5px solid var(--lime-edge)}
.card.off{border-color:var(--warn)}

.or{font-weight:700;color:var(--fg)}
.terms{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.7rem}
.terms li{display:grid;grid-template-columns:1.6rem 1fr;gap:.6rem;align-items:start;color:var(--mute);font-size:.95rem;line-height:1.45}
.terms li svg{width:1.4rem;height:1.4rem;margin-top:.05rem;fill:none;stroke:var(--lime);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.terms li b{color:var(--fg)}
.small{font-size:.85rem}
.foot{text-align:center}
.topup .paybar{position:sticky;bottom:0;z-index:5;display:flex;flex-direction:column;gap:.5rem;margin:0 -1.1rem -1.1rem;padding:.7rem 1.1rem calc(.85rem + env(safe-area-inset-bottom));border-radius:0 0 var(--r) var(--r);background:var(--surface);text-align:center}
.topup .paybar::before{content:'';position:absolute;left:0;right:0;bottom:100%;height:.75rem;background:linear-gradient(to top,var(--surface),rgb(21 24 27/0));pointer-events:none}
.topup .paybar .btn{font-size:1.125rem}
${PAY_MARKS_CSS}`;

/** Iconos de las condiciones (decorativos). */
const ICON = {
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  door: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h5v18h-5"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>',
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
function amountCard(lang: PayLanguage, view: HomeTopUpPageView): string {
  const t = HOME_TOPUP_TEXT[lang];
  const w = WALLET_TEXT[lang];
  const p = PAY_TEXT[lang];
  const h = escapeHtml;
  const middle = view.presetsCents[Math.floor((view.presetsCents.length - 1) / 2)];
  const radios = view.presetsCents
    .map(
      (c) =>
        `<label><input type="radio" name="amt" value="${c}"${c === middle ? ' checked' : ''}><span class="num">${h(eur(c, w.locale))}</span></label>`,
    )
    .join('');
  const limits = fill(fill(w.topUpLimits, 'min', eur(view.minCents, w.locale)), 'max', eur(view.maxCents, w.locale));
  const feeBps = view.serviceFeeBps ?? 0;
  const pct = new Intl.NumberFormat(w.locale, { style: 'percent', maximumFractionDigits: 2 }).format(feeBps / 10_000);
  const breakdown =
    feeBps > 0
      ? `<dl class="brk" id="brk" aria-live="off">
<div><dt>${h(t.toBalance)}</dt><dd class="num" id="bAmount"></dd></div>
<div class="fee"><dt>${h(p.breakdown.serviceFee)} <button class="why" type="button" id="whyBtn" aria-expanded="true" aria-controls="whyText">${h(p.feeWhat)}</button></dt><dd class="num" id="bFee"></dd><dd class="whytext" id="whyText">${h(p.feeExplain(pct))}</dd></div>
<div class="tot"><dt>${h(p.totalToPay)}</dt><dd class="num" id="bTotal"></dd></div>
</dl>`
      : '';
  return `<section class="card topup" aria-labelledby="amtTitle">
<h2 id="amtTitle">${h(t.amountLegend)}</h2>
<form id="f" class="tform" autocomplete="off" novalidate>
<fieldset><legend class="sr">${h(t.amountLegend)}</legend><div class="amts">${radios}<label><input type="radio" name="amt" value="other" id="amtOther"><span>${h(w.topUpOther)}</span></label></div></fieldset>
<div class="tother" id="otherBox" hidden><label for="otherIn">${h(w.topUpOtherLabel)}</label>
<div class="teur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" aria-describedby="limits"><span aria-hidden="true">€</span></div></div>
<p class="small" id="limits">${h(limits)}</p>
${breakdown}
<div class="paybar"><p class="err" id="err" role="alert" hidden></p>
<button class="btn" type="submit" id="go">${LOCK_IC}<span id="goLbl"></span></button>
<p class="small">${h(t.methods)}</p></div>
</form>
</section>
`;
}

/** Lo que tiene que saber antes de pagar. */
function termsCard(lang: PayLanguage, withFee: boolean): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  return `<section class="card" aria-labelledby="termsTitle">
<h2 id="termsTitle">${h(t.conditionsTitle)}</h2>
<ul class="terms">
<li>${ICON.clock}<span><b>${h(t.noExpiry)}</b></span></li>
<li>${ICON.back}<span>${h(t.refund)}${withFee ? ` ${h(t.refundFee)}` : ''}</span></li>
<li>${ICON.door}<span>${h(t.onArrival)}</span></li>
</ul>
</section>
`;
}

/** Ahora el local no deja cargar (pausa, formas de cobro, pasarela): sin formulario. */
function offCard(lang: PayLanguage): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  return `<section class="card off" role="status" aria-labelledby="offTitle">
<h2 id="offTitle">${h(t.offTitle)}</h2>
<p>${h(t.offBody)}</p>
</section>
`;
}

/** Textos que necesita el JS. */
function jsText(lang: PayLanguage): Record<string, string> {
  const t = HOME_TOPUP_TEXT[lang];
  const w = WALLET_TEXT[lang];
  return {
    go: t.go,
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
 pkPost(C.base+'/topup',{amountCents:c,key:K,lang:C.lang})
  .then(function(r){var u=r&&r.payUrl;if(typeof u==='string'&&u.indexOf('/pay/')===0){location.href=u;return;}throw new Error(T.error);})
  .catch(function(e){newKey();busy=false;setGo(b.getAttribute('data-label'),false);show('err',npErr(e,C.errors));});});
window.addEventListener('pageshow',function(e){if(e.persisted){busy=false;newKey();setGo($('go').getAttribute('data-label'),false);}});
newKey();upd();`;

export function renderHomeTopUpPage(code: string, lang: PayLanguage, view: HomeTopUpPageView): string {
  const t = HOME_TOPUP_TEXT[lang];
  const w = WALLET_TEXT[lang];
  const h = escapeHtml;
  const base = `/r/${encodeURIComponent(code)}`;
  const canLoad = view.problem === null;
  const withFee = (view.serviceFeeBps ?? 0) > 0;
  const config = jsConfig({
    base,
    lang,
    locale: w.locale,
    min: view.minCents,
    max: view.maxCents,
    fees: view.feesCents,
    text: jsText(lang),
    errors: { ...clientErrorConfig(lang), ...t.errors },
  });
  const venue = h(view.venueName);
  const heading = h(t.heading).split('{venue}').join(`<span>${venue}</span>`);
  return `<!DOCTYPE html>
<html lang="${PAY_TEXT[lang].htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f1112"><title>${h(`${t.title} · ${view.venueName}`)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${HOME_CSS}</style></head><body>
${topBar(lang)}
<main class="h">
<section class="hh" aria-labelledby="hTitle">
<p class="kick">${h(t.kick)}</p>
<h1 id="hTitle">${heading}</h1>
<p>${h(t.intro)}</p>
</section>
${canLoad && view.mine ? mineCard(lang, base, view.mine.codeHint) : ''}${canLoad ? amountCard(lang, view) : offCard(lang)}${termsCard(lang, withFee)}<p class="foot trust">${h(PAY_TEXT[lang].secure)}${CARD_MARKS}</p>
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
</body></html>`;
}

/** 404 sin pistas: no dice si el local existe, si lo apagó o si cambió el enlace. */
export function renderHomeTopUpGone(lang: PayLanguage): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  return `<!DOCTYPE html>
<html lang="${PAY_TEXT[lang].htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f1112"><title>${h(t.notFoundTitle)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${HOME_CSS}</style></head><body>
${topBar(lang)}
<main class="h">
<section class="card off" aria-labelledby="goneTitle">
<h1 id="goneTitle" class="sub">${h(t.notFoundTitle)}</h1>
<p>${h(t.notFoundBody)}</p>
</section>
</main>
<script>${LANG_JS}</script>
</body></html>`;
}
