import { CLUB_BASE_CSS, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../payments/customer-chrome';
import { CUSTOMER_TEXT } from '../payments/i18n';
import type { UnlockPageText } from '../payments/i18n/types';
import type { PayLanguage } from '../payments/pay-i18n';
import { myBalanceBlock } from './my-balance';
import { PASSKEY_BROWSER_JS } from './passkey-browser';

/**
 * Lo que enseña la página antes de desbloquear (/w/card/<ficha> y el enlace
 * privado con Face ID sin sesión). Nunca saldo, movimientos, id del saldo ni
 * su enlace privado: como mucho el código tapado (K7Q-•••).
 *  - locked: el saldo tiene Face ID → «Ver mi saldo» con la passkey.
 *  - setup: aún no tiene Face ID → cómo activarlo (QR de activación en
 *    recepción). Sin botón: con la ficha sola no se activa nada.
 *  - blocked: ese NFC está bloqueado (p. ej. «He perdido mi NFC»).
 *  - unavailable: no está dado a ningún saldo vivo.
 */
export type WalletUnlockView =
  | { kind: 'locked'; codeHint?: string | null; paidToken?: string }
  | { kind: 'setup'; codeHint?: string | null }
  | { kind: 'blocked' }
  | { kind: 'unavailable' };

type Text = UnlockPageText;

/** Iconos (los reusa la página del QR de activación, wallet-activation-page.ts). */
export const UNLOCK_ICON = {
  nfc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 10.5a2 2 0 0 1 0 3"/><path d="M9 8a6 6 0 0 1 0 8"/><path d="M12.5 5.5a9.5 9.5 0 0 1 0 13"/><path d="M16 3a13 13 0 0 1 0 18"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  face: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
};

export const UNLOCK_CSS = `
main{max-width:28rem;min-height:100svh;margin:0 auto;padding:1rem 1rem calc(1.5rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1.25rem}
main>.top{padding-left:0;padding-right:0}
svg{width:1.5rem;height:1.5rem;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ocard{min-height:8.75rem;padding:1rem 1.125rem;border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;color:var(--fg);background:var(--surface)}
.ocard.off{color:var(--dim)}
.otop,.obot{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.ocard .kick{color:inherit}
.otop svg{color:var(--mute)}
.ocard .shut svg{width:2.5rem;height:2.5rem;stroke-width:1.75;color:var(--mute)}
.obot{font-size:.875rem;font-weight:600;letter-spacing:.04em}
.act{display:flex;flex-direction:column;gap:1rem}
h1{font-size:1.75rem}
.lead{color:var(--fg);font-size:1.125rem;font-weight:400;line-height:1.45}
.where{display:flex;align-items:flex-start;gap:.75rem;padding:.875rem 1rem;border-radius:var(--r-tile);background:var(--surface);border:1px solid var(--line-hi);color:var(--fg)}
.where b{display:block;font-size:1rem}
.where span{color:var(--mute);font-size:.875rem}
.where svg{margin-top:.1rem;color:var(--mute)}
.btn svg{width:1.4rem;height:1.4rem}
.mark{width:4rem;height:4rem;border-radius:50%;display:grid;place-items:center;background:rgb(255 107 107/.12);color:var(--bad)}
.mark svg{width:2rem;height:2rem}
.foot{line-height:1.5}
`;

export function unlockCard(t: Text, codeHint: string | null | undefined, off: boolean): string {
  const h = escapeHtml;
  const code = codeHint ? `<span class="num"><span class="sr">${h(t.code)}: </span>${h(codeHint)}</span>` : '<span></span>';
  return `<section class="ocard${off ? ' off' : ''}" aria-label="${h(t.card)}"><div class="otop"><span class="kick">${h(t.card)}</span>${UNLOCK_ICON.nfc}</div><span class="shut">${UNLOCK_ICON.lock}</span><div class="obot">${code}</div></section>`;
}

function body(view: WalletUnlockView, t: Text, lang: PayLanguage): string {
  const h = escapeHtml;
  switch (view.kind) {
    case 'locked':
      return `${unlockCard(t, view.codeHint, false)}<section class="act"><h1>${h(t.heading)}</h1><p>${h(t.intro)}</p><button class="btn" id="unlock" type="button">${UNLOCK_ICON.face}<span id="unlockLabel">${h(t.button)}</span></button><p id="error" class="err" role="alert" hidden></p><p class="foot">${h(t.security)}</p><p class="foot">${h(t.newPhone)}</p></section>`;
    case 'setup':
      return `${unlockCard(t, view.codeHint, true)}<section class="act"><h1>${h(t.setupHeading)}</h1><p class="lead">${h(t.setup)}</p><div class="where">${UNLOCK_ICON.pin}<div><b>${h(t.setupWhere)}</b><span>${h(t.setupHow)}</span></div></div><p class="foot">${h(t.setupFoot)}</p></section>`;
    // Quien la bloqueó lo hizo con su Face ID: «Ver mi saldo» con su llave lleva a SU saldo
    // (el botón solo sale si el móvil tiene llaves; sin saldo en este móvil, lo dice).
    case 'blocked':
      return `<section class="act"><span class="mark">${UNLOCK_ICON.lock}</span><h1>${h(t.blockedHeading)}</h1><p class="lead">${h(t.blocked)}</p>${myBalanceBlock(lang, { withPasskeyJs: true })}</section>`;
    case 'unavailable':
      return `<section class="act"><h1>${h(t.unavailableHeading)}</h1><p class="lead">${h(t.unavailableText)}</p></section>`;
  }
}

/** Solo en `locked`: pide el reto al abrir y, al tocar, Face ID y a /w/<enlace>. Sin barras invertidas. */
function unlockScript(base: string, lang: PayLanguage, t: Text, paid: string | null): string {
  return `<script>
(function(){'use strict';var C=JSON.parse(${jsConfig({ base, lang, t, paid })}),b=document.getElementById('unlock'),l=document.getElementById('unlockLabel'),e=document.getElementById('error'),busy=false;
${PASSKEY_BROWSER_JS}
function message(text){e.textContent=text;e.hidden=!text;}
var prepared=pkSupported()?pkPrepare(C.base+'/view/challenge'):null;
if(!prepared){b.disabled=true;message(C.t.unsupported);}
b.addEventListener('click',function(){if(busy||!prepared)return;busy=true;b.disabled=true;l.textContent=C.t.waiting;message('');
prepared().then(function(response){return pkPost(C.base+'/view',{response:response});}).then(function(result){
if(typeof result.url!=='string')throw new Error('invalid destination');
var dest=new URL(result.url,window.location.origin),parts=dest.pathname.split('/');
if(dest.origin!==window.location.origin||parts.length!==3||parts[1]!=='w'||!/^[A-Za-z0-9_-]+$/.test(parts[2]))throw new Error('invalid destination');
// «Recargar» (#recargar) sigue abierto al llegar al saldo.
window.location.replace(dest.pathname+'?lang='+encodeURIComponent(C.lang)+(C.paid?'&pagado='+encodeURIComponent(C.paid):'')+(window.location.hash==='#recargar'?'#recargar':''));
}).catch(function(err){message(pkCancelled(err)?C.t.cancelled:err.code==='FACE_ID_NOT_SET'?C.t.setup:err.code==='FACE_ID_WRONG'||err.code==='FACE_ID_UNKNOWN'?C.t.wrong:err.code==='FACE_ID_TIMEOUT'||err.code==='FACE_ID_USED'?C.t.expired:err.status===429?C.t.rateLimited:err.status===404||err.status===409?C.t.unavailable:C.t.error);
}).then(function(){busy=false;b.disabled=false;l.textContent=C.t.button;prepared=pkPrepare(C.base+'/view/challenge');});});
})();
${LANG_JS}</script>`;
}

export function renderWalletUnlockPage(base: string, lang: PayLanguage, view: WalletUnlockView = { kind: 'locked' }): string {
  const t = CUSTOMER_TEXT[lang].unlockPage;
  const h = escapeHtml;
  const paid = view.kind === 'locked' && view.paidToken && /^[A-Za-z0-9_-]{16,64}$/.test(view.paidToken) ? view.paidToken : null;
  // El selector de idioma conserva el «Pagado» que viene del banco (?pagado=).
  const langHref = (l: PayLanguage): string => `${base}?lang=${l}${paid ? `&pagado=${paid}` : ''}`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${h(t.title)}</title><style>${CLUB_BASE_CSS}${CHROME_CSS}${UNLOCK_CSS}</style></head><body><main>`
    + topBar(lang, langHref)
    + body(view, t, lang)
    + `</main>${view.kind === 'locked' ? unlockScript(base, lang, t, paid) : ''}</body></html>`;
}
