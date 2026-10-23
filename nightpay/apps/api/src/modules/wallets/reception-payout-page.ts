import { CLUB_BASE_CSS, brandWordmark, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { PASSKEY_BROWSER_JS } from './passkey-browser';

/**
 * La página que abre el cliente en SU móvil al escanear el QR de la salida
 * de recepción: «Recepción te devuelve 35,00 € en efectivo» y confirmarlo con
 * su Face ID (huella o el código del teléfono). Ni el código del saldo, ni
 * su id, ni su enlace privado: solo el importe y el local. Texto dinámico
 * con textContent.
 */

export interface PayoutConfirmView {
  amountCents: number;
  venueName: string;
  confirmed: boolean;
}

const TEXT = {
  es: {
    title: 'Confirmar la salida',
    gives: 'Recepción te devuelve',
    inCash: 'en efectivo',
    intro: 'Confírmalo con Face ID, huella o el código de tu teléfono. Sin tu confirmación no sale el dinero.',
    button: 'Confirmar con Face ID',
    waiting: 'Confirma en tu teléfono…',
    done: 'Confirmado. Recepción ya puede darte el efectivo.',
    gone: 'Este QR ya no vale. Pide a recepción que lo enseñe otra vez.',
    unsupported: 'Este navegador no puede confirmar con Face ID. Ábrelo en Safari o Chrome en tu teléfono.',
    cancelled: 'Cancelado. Puedes volver a intentarlo.',
    wrong: 'Usa el teléfono con el Face ID de este saldo.',
    expired: 'La confirmación ha caducado. Vuelve a intentarlo.',
    rateLimited: 'Demasiados intentos seguidos. Espera un momento.',
    error: 'No se pudo confirmar. Vuelve a intentarlo.',
    security: 'El código lo pide tu teléfono. No lo escribas en esta página.',
  },
  en: {
    title: 'Confirm your cash-out',
    gives: 'Reception is giving you',
    inCash: 'in cash',
    intro: 'Confirm with Face ID, your fingerprint or your phone screen lock. No money leaves without your confirmation.',
    button: 'Confirm with Face ID',
    waiting: 'Confirm on your phone…',
    done: 'Confirmed. Reception can now hand you the cash.',
    gone: 'This QR is no longer valid. Ask reception to show it again.',
    unsupported: 'This browser cannot confirm with Face ID. Open it in Safari or Chrome on your phone.',
    cancelled: 'Cancelled. You can try again.',
    wrong: 'Use the phone with the Face ID of this balance.',
    expired: 'Confirmation expired. Try again.',
    rateLimited: 'Too many attempts. Wait a moment.',
    error: 'Could not confirm. Try again.',
    security: 'Your phone asks for its screen lock. Never type it on this page.',
  },
} as const;

/** «35 €», «35,50 €» (en inglés, «€35»): como en las demás páginas del cliente. */
function money(cents: number, lang: PayLanguage): string {
  return clientMoney(cents, PAY_TEXT[lang].locale);
}

export function renderPayoutConfirmPage(base: string, lang: PayLanguage, view: PayoutConfirmView | null): string {
  const t = TEXT[lang];
  const amount = view ? `<p class="kick">${escapeHtml(t.gives)}</p><p class="amt">${escapeHtml(money(view.amountCents, lang))}</p><p class="sub">${escapeHtml(t.inCash)}${view.venueName ? ` · ${escapeHtml(view.venueName)}` : ''}</p>` : '';
  const body = !view
    ? `<p class="err" role="alert">${escapeHtml(t.gone)}</p>`
    : view.confirmed
      ? `${amount}<p class="ok" role="status">${escapeHtml(t.done)}</p>`
      : `${amount}<p>${escapeHtml(t.intro)}</p><button class="btn" id="confirm" type="button">${escapeHtml(t.button)}</button><p id="error" class="err" role="alert" hidden></p><p id="done" class="ok" role="status" hidden>${escapeHtml(t.done)}</p><p class="foot">${escapeHtml(t.security)}</p>`;
  const script = view && !view.confirmed ? `<script>
(function(){'use strict';var C=JSON.parse(${jsConfig({ base, t })}),b=document.getElementById('confirm'),e=document.getElementById('error'),d=document.getElementById('done'),busy=false;
${PASSKEY_BROWSER_JS}
function message(text){e.textContent=text;e.hidden=!text;}
var prepared=pkSupported()?pkPrepare(C.base+'/challenge'):null;
if(!prepared){b.disabled=true;message(C.t.unsupported);}
b.addEventListener('click',function(){if(busy||!prepared)return;busy=true;b.disabled=true;b.textContent=C.t.waiting;message('');
prepared().then(function(response){return pkPost(C.base+'/confirm',{response:response});}).then(function(){b.hidden=true;d.hidden=false;prepared=null;
}).catch(function(err){message(pkCancelled(err)?C.t.cancelled:err.code==='FACE_ID_WRONG'||err.code==='FACE_ID_UNKNOWN'?C.t.wrong:err.code==='FACE_ID_TIMEOUT'||err.code==='FACE_ID_USED'?C.t.expired:err.status===429?C.t.rateLimited:err.status===404||err.status===410?C.t.gone:C.t.error);
b.disabled=false;b.textContent=C.t.button;prepared=pkPrepare(C.base+'/challenge');}).then(function(){busy=false;});});
})();</script>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(t.title)}</title><style>${CLUB_BASE_CSS}
main{max-width:28rem;min-height:100svh;margin:auto;padding:2rem 1rem;display:flex;flex-direction:column;justify-content:center;gap:1.5rem}main>.wm{align-self:flex-start;max-width:100%;object-fit:contain}.box{padding:1.5rem;border:1px solid var(--line-hi);border-radius:var(--r);background:var(--surface);display:grid;gap:1rem}.kick{margin:0;color:var(--label);font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:.8rem}.amt{margin:0;font:800 3.2rem/1 var(--num);color:var(--lime)}.sub{margin:0;color:var(--mute)}.ok{color:var(--ok);font-weight:700}.foot{line-height:1.5;color:var(--dim)}</style></head><body><main>${brandWordmark()}<section class="box"><h1>${escapeHtml(t.title)}</h1>${body}</section></main>${script}</body></html>`;
}
