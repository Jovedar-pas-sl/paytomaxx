import { CLUB_BASE_CSS, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../payments/customer-chrome';
import { CUSTOMER_TEXT } from '../payments/i18n';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { CLIENT_ERROR_JS, clientErrorConfig } from './client-errors';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import type { ActivationView } from './wallet-activation-use.service';
import { UNLOCK_CSS, UNLOCK_ICON, unlockCard } from './wallet-unlock-page';

/**
 * /w/a/<token>: la página del QR de activación de un solo uso (M-2). La abre
 * el cliente con la cámara del móvil desde la pantalla «Cargado» de
 * recepción (o el enlace nuevo que le da el dueño).
 *  - ok: activar el desbloqueo del móvil (Face ID, huella o bloqueo de
 *    pantalla) o, si lo prefiere (o su navegador no puede), elegir un PIN.
 *    Lo primero que registre gasta el QR. Después su móvil va a su saldo
 *    (/w/<enlace>, con su sesión si es Face ID); si el saldo ya tenía PIN, se
 *    le avisa antes, por si no lo eligió él.
 *  - used / expired: «Este enlace ya se ha usado / ha caducado. Pide otro en
 *    recepción.», sin botones.
 * Mirar la página no cambia nada (las vistas previas de WhatsApp la abren).
 * Nunca lleva el enlace del saldo ni lo que tiene: el código tapado y el local.
 * El JS va dentro de una plantilla de TypeScript: sin barras invertidas.
 */

const ACTIVATION_CSS = `
.pins{display:flex;gap:.5rem;justify-content:center}
.pins input{width:7.5rem;min-height:3.25rem;font:inherit;font-size:1.4rem;text-align:center;border-radius:14px;border:2px solid var(--line-hi);background:var(--surface-2);color:var(--fg);letter-spacing:.3em}
.pins input:focus-visible{outline:3px solid var(--lime);outline-offset:2px}
.pins input::placeholder{letter-spacing:normal;font-size:1rem;color:var(--dim)}
.pinbox{display:flex;flex-direction:column;gap:.8rem}
.done{color:var(--fg);font-weight:700;font-size:1.05rem}
.warn{padding:.9rem 1rem;border-radius:var(--r-tile);border:1px solid var(--warn);color:var(--fg);font-weight:600}
`;

function body(view: ActivationView, lang: PayLanguage): string {
  const a = CUSTOMER_TEXT[lang].activation;
  const w = CUSTOMER_TEXT[lang].wallet;
  const u = CUSTOMER_TEXT[lang].unlockPage;
  const h = escapeHtml;
  if (view.state !== 'ok') {
    const heading = view.state === 'used' ? a.usedHeading : a.expiredHeading;
    const text = view.state === 'used' ? a.used : a.expired;
    return `<section class="act"><span class="mark">${UNLOCK_ICON.lock}</span><h1>${h(heading)}</h1><p class="lead">${h(text)}</p></section>`;
  }
  const label = view.venueName ? `${w.balance} · ${view.venueName}` : w.balance;
  const card = unlockCard({ ...u, card: label }, view.codeHint, false);
  return `${card}<section class="act">
<h1>${h(a.heading)}</h1>
<p class="lead">${h(a.intro)}</p>
<button class="btn" id="faceOn" type="button" hidden>${UNLOCK_ICON.face}<span id="faceLabel"></span></button>
<button class="link" id="pinOffer" type="button" hidden>${h(a.pinOffer)}</button>
<form class="pinbox" id="pinForm" autocomplete="off" hidden>
<p>${h(a.pinWhy)}</p>
<div class="pins"><input id="pin1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(w.pinLabel)}" placeholder="${h(w.pinLabel)}"><input id="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(w.pinRepeat)}" placeholder="${h(w.pinRepeat)}"></div>
<button class="btn" type="submit" id="pinGo">${h(w.pinSave)}</button>
</form>
<p class="err" id="err" role="alert" hidden></p>
<p class="done" id="done" role="status" hidden></p>
<p class="warn" id="warn" role="status" hidden>${h(a.hadPin)}</p>
<a class="btn" id="go" href="#" hidden>${h(a.go)}</a>
<p class="foot">${h(u.security)}</p>
</section>`;
}

/** Solo en `ok`: activar (o el PIN) contra <base>/passkey… y <base>/pin, y a /w/<enlace> de este dominio. */
function activationScript(base: string, lang: PayLanguage, view: Extract<ActivationView, { state: 'ok' }>): string {
  const a = CUSTOMER_TEXT[lang].activation;
  const w = CUSTOMER_TEXT[lang].wallet;
  const p = PAY_TEXT[lang];
  const config = jsConfig({
    base,
    lang,
    hasPin: view.hasPin,
    t: a,
    w: { pinFormat: w.pinFormat, pinMismatch: w.pinMismatch, pinSave: w.pinSave },
    unlock: p.unlock,
    waiting: p.unlockWaiting,
    sending: w.sending,
    errors: clientErrorConfig(lang),
  });
  return `<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
(function(){'use strict';var C=JSON.parse(${config}),T=C.t,busy=false;
function $(id){return document.getElementById(id);}
function show(id,text){$(id).textContent=text||'';$(id).hidden=!text;}
var ua=navigator.userAgent||'',P=/iPhone|iPad|iPod/.test(ua)||(ua.indexOf('Macintosh')>-1&&navigator.maxTouchPoints>1)?'ios':ua.indexOf('Android')>-1?'android':'other',U=C.unlock[P];
var face=$('faceOn'),label=$('faceLabel'),canKey=pkSupported();
label.textContent=U.button;face.hidden=!canKey;
if(!C.hasPin){if(canKey)$('pinOffer').hidden=false;else $('pinForm').hidden=false;}
if(!canKey)show('err',T.unsupported);
function dest(u){if(typeof u!=='string')return null;var d=new URL(u,window.location.origin),parts=d.pathname.split('/');
 if(d.origin!==window.location.origin||parts.length!==3||parts[1]!=='w'||!/^[A-Za-z0-9_-]+$/.test(parts[2]))return null;
 return d.pathname+'?lang='+encodeURIComponent(C.lang);}
function done(r,hadPin){var to=dest(r&&r.url);if(!to)throw new Error('destino');
 face.hidden=true;$('pinOffer').hidden=true;$('pinForm').hidden=true;show('err','');
 if(hadPin){$('warn').hidden=false;var g=$('go');g.href=to;g.hidden=false;g.focus();return;}
 show('done',T.done);window.location.replace(to);}
face.addEventListener('click',function(){if(busy)return;busy=true;face.disabled=true;label.textContent=C.waiting;show('err','');
 pkCreate(C.base+'/passkey/options').then(function(k){return pkPost(C.base+'/passkey',{response:k});})
  .then(function(r){done(r,r&&r.hadPin===true);})
  .catch(function(e){busy=false;face.disabled=false;label.textContent=U.button;show('err',pkCancelled(e)?T.cancelled:npErr(e,C.errors));});});
$('pinOffer').addEventListener('click',function(){$('pinForm').hidden=false;$('pinOffer').hidden=true;$('pin1').focus();});
$('pinForm').addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;show('err','');
 var x=$('pin1').value,y=$('pin2').value,b=$('pinGo');
 if(!/^[0-9]{4}$/.test(x)){show('err',C.w.pinFormat);return;}
 if(x!==y){show('err',C.w.pinMismatch);return;}
 busy=true;b.disabled=true;b.textContent=C.sending;
 pkPost(C.base+'/pin',{pin:x,pin2:y}).then(function(r){done(r,false);})
  .catch(function(e){busy=false;b.disabled=false;b.textContent=C.w.pinSave;$('pin1').value='';$('pin2').value='';show('err',npErr(e,C.errors));});});
})();
${LANG_JS}</script>`;
}

export function renderActivationPage(base: string, lang: PayLanguage, view: ActivationView): string {
  const a = CUSTOMER_TEXT[lang].activation;
  const h = escapeHtml;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f1112"><title>${h(a.title)}</title><style>${CLUB_BASE_CSS}${CHROME_CSS}${UNLOCK_CSS}${ACTIVATION_CSS}</style></head><body><main>`
    + topBar(lang, (l: PayLanguage) => `${base}?lang=${l}`)
    + body(view, lang)
    + `</main>${view.state === 'ok' ? activationScript(base, lang, view) : `<script>${LANG_JS}</script>`}</body></html>`;
}
