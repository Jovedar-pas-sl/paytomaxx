import { CLUB_BASE_CSS, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../payments/customer-chrome';
import { CUSTOMER_TEXT } from '../payments/i18n';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { myBalanceBlock, myBalanceButton, myBalanceScript } from './my-balance';
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

/** «35 €», «35,50 €» (en inglés, «€35»): como en las demás páginas del cliente. */
function money(cents: number, lang: PayLanguage): string {
  return clientMoney(cents, PAY_TEXT[lang].locale);
}

export function renderPayoutConfirmPage(base: string, lang: PayLanguage, view: PayoutConfirmView | null): string {
  const t = CUSTOMER_TEXT[lang].payout;
  const amount = view ? `<p class="kick">${escapeHtml(t.gives)}</p><p class="amt">${escapeHtml(money(view.amountCents, lang))}</p><p class="sub">${escapeHtml(t.inCash)}${view.venueName ? ` · ${escapeHtml(view.venueName)}` : ''}</p>` : '';
  const body = !view
    ? `<p class="err" role="alert">${escapeHtml(t.gone)}</p>`
    : view.confirmed
      ? // Ya confirmada: «Ver mi saldo» con su Face ID (lo que se le devolvió sale en sus movimientos).
        `${amount}<p class="ok" role="status">${escapeHtml(t.done)}</p>${myBalanceBlock(lang, { withPasskeyJs: true })}`
      : `${amount}<p>${escapeHtml(t.intro)}</p><button class="btn" id="confirm" type="button">${escapeHtml(t.button)}</button><p id="error" class="err" role="alert" hidden></p><p id="done" class="ok" role="status" hidden>${escapeHtml(t.done)}</p>${myBalanceButton(lang)}<p class="foot">${escapeHtml(t.security)}</p>`;
  const script = view && !view.confirmed ? `<script>
(function(){'use strict';var C=JSON.parse(${jsConfig({ base, t })}),b=document.getElementById('confirm'),e=document.getElementById('error'),d=document.getElementById('done'),busy=false;
${PASSKEY_BROWSER_JS}
function message(text){e.textContent=text;e.hidden=!text;}
var prepared=pkSupported()?pkPrepare(C.base+'/challenge'):null;
if(!prepared){b.disabled=true;message(C.t.unsupported);}
b.addEventListener('click',function(){if(busy||!prepared)return;busy=true;b.disabled=true;b.textContent=C.t.waiting;message('');
prepared().then(function(response){return pkPost(C.base+'/confirm',{response:response});}).then(function(){b.hidden=true;d.hidden=false;prepared=null;if(window.npMineShow)window.npMineShow(true);
}).catch(function(err){message(pkCancelled(err)?C.t.cancelled:err.code==='FACE_ID_WRONG'||err.code==='FACE_ID_UNKNOWN'?C.t.wrong:err.code==='FACE_ID_TIMEOUT'||err.code==='FACE_ID_USED'?C.t.expired:err.status===429?C.t.rateLimited:err.status===404||err.status===410?C.t.gone:C.t.error);
b.disabled=false;b.textContent=C.t.button;prepared=pkPrepare(C.base+'/challenge');}).then(function(){busy=false;});});
})();
${LANG_JS}</script>${myBalanceScript(lang)}` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${escapeHtml(t.title)}</title><style>${CLUB_BASE_CSS}${CHROME_CSS}
main{max-width:28rem;min-height:calc(100svh - 3.5rem);margin:auto;padding:1rem 1rem 2rem;display:flex;flex-direction:column;justify-content:center;gap:1.5rem}.box{padding:1.5rem 1.25rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);display:grid;gap:1rem}.box h1{font-size:1.375rem}.kick{margin:0}.amt{margin:0;font:600 3rem/1 var(--num);letter-spacing:-.02em;color:var(--fg)}.sub{margin:0;color:var(--mute)}.ok{color:var(--ok);font-weight:600}.foot{line-height:1.5;color:var(--dim)}</style></head><body>${topBar(lang, (l) => `${base}?lang=${l}`)}<main><section class="box"><h1>${escapeHtml(t.title)}</h1>${body}</section></main>${script}</body></html>`;
}
