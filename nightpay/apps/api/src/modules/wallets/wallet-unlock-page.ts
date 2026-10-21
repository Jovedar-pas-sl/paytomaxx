import { CLUB_BASE_CSS, brandWordmark, escapeHtml, jsConfig } from '../payments/club-ui';
import type { PayLanguage } from '../payments/pay-i18n';
import { PASSKEY_BROWSER_JS } from './passkey-browser';

/** Nunca recibe saldo, movimientos, id del saldo ni su enlace privado. */
export function renderWalletUnlockPage(base: string, lang: PayLanguage, paidToken?: string): string {
  const t = lang === 'es' ? {
    title: 'Tu saldo', heading: 'Consulta tu saldo',
    intro: 'Desbloquea con Face ID, huella o el código de tu teléfono para ver tu saldo y movimientos.',
    button: 'Ver mi saldo', waiting: 'Confirma en tu teléfono…',
    setup: '¿Es la primera vez? Activa el desbloqueo desde el enlace privado de tu recarga. Si no lo tienes, pide ayuda en recepción.',
    security: 'El código lo pide tu teléfono. No lo escribas en esta página.',
    unsupported: 'Este navegador no permite desbloquear tu saldo. Abre el enlace en Safari o Chrome en tu teléfono, con HTTPS.',
    cancelled: 'Consulta cancelada. Puedes volver a intentarlo.',
    wrong: 'Usa la passkey vinculada a este saldo. Desbloquear otro teléfono no da acceso.',
    expired: 'La confirmación ha caducado. Vuelve a intentarlo.',
    unavailable: 'No se puede consultar esta ficha. Comprueba que siga activa en recepción.',
    rateLimited: 'Demasiadas consultas seguidas. Espera un momento y vuelve a intentarlo.',
    error: 'No se pudo abrir el saldo. Vuelve a intentarlo.',
  } : {
    title: 'Your balance', heading: 'Check your balance',
    intro: 'Use Face ID, your fingerprint or your phone screen lock to view your balance and transactions.',
    button: 'View my balance', waiting: 'Confirm on your phone…',
    setup: 'First time? Activate screen-lock access from your private top-up link. Ask reception if you do not have it.',
    security: 'Your phone asks for its screen lock. Never type it on this page.',
    unsupported: 'This browser cannot unlock your balance. Open the HTTPS link in Safari or Chrome on your phone.',
    cancelled: 'Cancelled. You can try again.', wrong: 'Use the passkey linked to this balance. Another phone cannot unlock it.',
    expired: 'Confirmation expired. Try again.', rateLimited: 'Too many requests. Wait a moment and try again.', unavailable: 'This card is unavailable. Ask reception to check it.', error: 'Could not open your balance. Try again.',
  };
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(t.title)}</title><style>${CLUB_BASE_CSS}
main{max-width:28rem;min-height:100svh;margin:auto;padding:2rem 1rem;display:flex;flex-direction:column;justify-content:center;gap:1.5rem}main>.wm{align-self:flex-start;max-width:100%;object-fit:contain}.lock{padding:1.5rem;border:1px solid var(--line-hi);border-radius:var(--r);background:var(--surface);display:grid;gap:1.25rem}h1{font-size:2rem}.foot{line-height:1.5}</style></head><body><main>${brandWordmark()}<section class="lock"><h1>${escapeHtml(t.heading)}</h1><p>${escapeHtml(t.intro)}</p><button class="btn" id="unlock" type="button">${escapeHtml(t.button)}</button><p id="error" class="err" role="alert" hidden></p><p class="foot">${escapeHtml(t.security)}</p></section><p class="foot">${escapeHtml(t.setup)}</p></main><script>
(function(){'use strict';var C=JSON.parse(${jsConfig({ base, lang, t, paid: paidToken && /^[A-Za-z0-9_-]{16,64}$/.test(paidToken) ? paidToken : null })}),b=document.getElementById('unlock'),e=document.getElementById('error'),busy=false;
${PASSKEY_BROWSER_JS}
function message(text){e.textContent=text;e.hidden=!text;}
var prepared=pkSupported()?pkPrepare(C.base+'/view/challenge'):null;
if(!prepared){b.disabled=true;message(C.t.unsupported);}
b.addEventListener('click',function(){if(busy||!prepared)return;busy=true;b.disabled=true;b.textContent=C.t.waiting;message('');
prepared().then(function(response){return pkPost(C.base+'/view',{response:response});}).then(function(result){
if(typeof result.url!=='string')throw new Error('invalid destination');
var dest=new URL(result.url,window.location.origin),parts=dest.pathname.split('/');
if(dest.origin!==window.location.origin||parts.length!==3||parts[1]!=='w'||!/^[A-Za-z0-9_-]+$/.test(parts[2]))throw new Error('invalid destination');
window.location.replace(dest.pathname+'?lang='+encodeURIComponent(C.lang)+(C.paid?'&pagado='+encodeURIComponent(C.paid):''));
}).catch(function(err){message(pkCancelled(err)?C.t.cancelled:err.code==='FACE_ID_NOT_SET'?C.t.setup:err.code==='FACE_ID_WRONG'||err.code==='FACE_ID_UNKNOWN'?C.t.wrong:err.code==='FACE_ID_TIMEOUT'||err.code==='FACE_ID_USED'?C.t.expired:err.status===429?C.t.rateLimited:err.status===404||err.status===409?C.t.unavailable:C.t.error);
}).then(function(){busy=false;b.disabled=false;b.textContent=C.t.button;prepared=pkPrepare(C.base+'/view/challenge');});});
})();</script></body></html>`;
}
