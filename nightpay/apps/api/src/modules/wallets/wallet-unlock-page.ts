import { CLUB_BASE_CSS, brandWordmark, escapeHtml, jsConfig } from '../payments/club-ui';
import type { PayLanguage } from '../payments/pay-i18n';
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

const TEXT = {
  es: {
    title: 'Tu saldo', card: 'Tu saldo', other: 'EN', otherLabel: 'English',
    heading: 'Consulta tu saldo',
    intro: 'Desbloquea con Face ID, huella o el código de tu teléfono para ver tu saldo y movimientos.',
    button: 'Ver mi saldo', waiting: 'Confirma en tu teléfono…',
    security: 'El código lo pide tu teléfono. No lo escribas en esta página.',
    newPhone: '¿Móvil nuevo? Tu saldo se abre con el móvil donde activaste Face ID. Si no lo tienes, pide ayuda en recepción.',
    setupHeading: 'Activa tu saldo en el móvil',
    setup: 'Para ver tu saldo en tu móvil, pide en recepción el QR de activación.',
    setupWhere: 'Recepción',
    setupHow: 'Escanéalo con la cámara y activa Face ID. Después, acerca tu NFC al móvil y verás tu saldo.',
    setupFoot: 'Mientras tanto, tu NFC paga como siempre.',
    blockedHeading: 'Este NFC está bloqueado',
    blocked: 'Ya no paga. Si es tuyo, tu saldo sigue a salvo: en recepción te dan un NFC nuevo con tu código.',
    unavailableHeading: 'Este NFC no está activo',
    unavailableText: 'Ahora no está dado a ningún saldo. Si acabas de recargar, pregunta en recepción.',
    code: 'Tu código',
    unsupported: 'Este navegador no permite desbloquear tu saldo. Abre el enlace en Safari o Chrome en tu teléfono, con HTTPS.',
    cancelled: 'Consulta cancelada. Puedes volver a intentarlo.',
    wrong: 'Usa la passkey vinculada a este saldo. Desbloquear otro teléfono no da acceso.',
    expired: 'La confirmación ha caducado. Vuelve a intentarlo.',
    unavailable: 'No se puede consultar este NFC. Comprueba en recepción que siga activo.',
    rateLimited: 'Demasiadas consultas seguidas. Espera un momento y vuelve a intentarlo.',
    error: 'No se pudo abrir el saldo. Vuelve a intentarlo.',
  },
  en: {
    title: 'Your balance', card: 'Your balance', other: 'ES', otherLabel: 'Español',
    heading: 'Check your balance',
    intro: 'Use Face ID, your fingerprint or your phone screen lock to view your balance and transactions.',
    button: 'View my balance', waiting: 'Confirm on your phone…',
    security: 'Your phone asks for its screen lock. Never type it on this page.',
    newPhone: 'New phone? Your balance opens on the phone where you turned on Face ID. If you do not have it, ask reception for help.',
    setupHeading: 'Set up your balance on your phone',
    setup: 'To see your balance on your phone, ask reception for the activation QR.',
    setupWhere: 'Reception',
    setupHow: 'Scan it with your camera and turn on Face ID. Then hold your NFC to your phone to see your balance.',
    setupFoot: 'Meanwhile, your NFC pays as usual.',
    blockedHeading: 'This NFC is blocked',
    blocked: 'It can no longer pay. If it is yours, your balance is safe: reception will give you a new NFC with your code.',
    unavailableHeading: 'This NFC is not active',
    unavailableText: 'It is not linked to any balance right now. If you just topped up, ask at reception.',
    code: 'Your code',
    unsupported: 'This browser cannot unlock your balance. Open the HTTPS link in Safari or Chrome on your phone.',
    cancelled: 'Cancelled. You can try again.',
    wrong: 'Use the passkey linked to this balance. Another phone cannot unlock it.',
    expired: 'Confirmation expired. Try again.',
    unavailable: 'This NFC cannot be checked. Ask reception to make sure it is still active.',
    rateLimited: 'Too many requests. Wait a moment and try again.',
    error: 'Could not open your balance. Try again.',
  },
} as const;

type Text = (typeof TEXT)[PayLanguage];

const ICON = {
  nfc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 10.5a2 2 0 0 1 0 3"/><path d="M9 8a6 6 0 0 1 0 8"/><path d="M12.5 5.5a9.5 9.5 0 0 1 0 13"/><path d="M16 3a13 13 0 0 1 0 18"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  face: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
};

const UNLOCK_CSS = `
main{max-width:28rem;min-height:100svh;margin:0 auto;padding:1rem 1rem calc(1.5rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1.25rem}
.top{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:3rem}
.top .wm{height:1.3rem;max-width:60%;object-fit:contain}
.lang{display:inline-flex;align-items:center;min-height:3rem;padding:0 .5rem;font-weight:700;color:var(--label);text-decoration:none}
.lang:hover{color:var(--fg)}
svg{width:1.5rem;height:1.5rem;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ocard{position:relative;isolation:isolate;overflow:hidden;min-height:10.5rem;padding:1rem 1.15rem;border-radius:24px;display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;color:var(--cream);background:var(--bits),linear-gradient(135deg,var(--green-1) 0%,var(--green-2) 55%,var(--green-3) 100%);box-shadow:0 0 0 1px var(--lime-edge),0 18px 40px -20px var(--lime-glow)}
.ocard::after{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(118deg,transparent 38%,var(--lime-soft) 50%,transparent 62%);pointer-events:none}
.ocard.off{color:var(--label);background:var(--bits),var(--surface);box-shadow:0 0 0 1px var(--line-hi)}
.ocard.off::after{display:none}
.otop,.obot{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.ocard .kick{color:inherit}
.ocard .shut svg{width:2.75rem;height:2.75rem;stroke-width:1.75}
.obot{font-size:1rem;font-weight:700;letter-spacing:.04em}
.act{display:flex;flex-direction:column;gap:1rem}
h1{font-size:2rem}
.lead{color:var(--fg);font-size:1.15rem;font-weight:600;line-height:1.4}
.where{display:flex;align-items:flex-start;gap:.75rem;padding:.9rem 1rem;border-radius:var(--r-tile);background:var(--surface);border:1px dashed var(--lime-edge);color:var(--fg)}
.where b{display:block;font-size:1.05rem}
.where span{color:var(--mute);font-size:.95rem}
.where svg{margin-top:.1rem;color:var(--lime)}
.btn svg{width:1.6rem;height:1.6rem}
.mark{width:4rem;height:4rem;border-radius:50%;display:grid;place-items:center;background:rgb(255 90 95/.16);color:var(--bad)}
.mark svg{width:2rem;height:2rem}
.foot{line-height:1.5}
`;

function card(t: Text, codeHint: string | null | undefined, off: boolean): string {
  const h = escapeHtml;
  const code = codeHint ? `<span class="num"><span class="sr">${h(t.code)}: </span>${h(codeHint)}</span>` : '<span></span>';
  return `<section class="ocard${off ? ' off' : ''}" aria-label="${h(t.card)}"><div class="otop"><span class="kick">${h(t.card)}</span>${ICON.nfc}</div><span class="shut">${ICON.lock}</span><div class="obot">${code}</div></section>`;
}

function body(view: WalletUnlockView, t: Text): string {
  const h = escapeHtml;
  switch (view.kind) {
    case 'locked':
      return `${card(t, view.codeHint, false)}<section class="act"><h1>${h(t.heading)}</h1><p>${h(t.intro)}</p><button class="btn" id="unlock" type="button">${ICON.face}<span id="unlockLabel">${h(t.button)}</span></button><p id="error" class="err" role="alert" hidden></p><p class="foot">${h(t.security)}</p><p class="foot">${h(t.newPhone)}</p></section>`;
    case 'setup':
      return `${card(t, view.codeHint, true)}<section class="act"><h1>${h(t.setupHeading)}</h1><p class="lead">${h(t.setup)}</p><div class="where">${ICON.pin}<div><b>${h(t.setupWhere)}</b><span>${h(t.setupHow)}</span></div></div><p class="foot">${h(t.setupFoot)}</p></section>`;
    case 'blocked':
      return `<section class="act"><span class="mark">${ICON.lock}</span><h1>${h(t.blockedHeading)}</h1><p class="lead">${h(t.blocked)}</p></section>`;
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
window.location.replace(dest.pathname+'?lang='+encodeURIComponent(C.lang)+(C.paid?'&pagado='+encodeURIComponent(C.paid):''));
}).catch(function(err){message(pkCancelled(err)?C.t.cancelled:err.code==='FACE_ID_NOT_SET'?C.t.setup:err.code==='FACE_ID_WRONG'||err.code==='FACE_ID_UNKNOWN'?C.t.wrong:err.code==='FACE_ID_TIMEOUT'||err.code==='FACE_ID_USED'?C.t.expired:err.status===429?C.t.rateLimited:err.status===404||err.status===409?C.t.unavailable:C.t.error);
}).then(function(){busy=false;b.disabled=false;l.textContent=C.t.button;prepared=pkPrepare(C.base+'/view/challenge');});});
})();</script>`;
}

export function renderWalletUnlockPage(base: string, lang: PayLanguage, view: WalletUnlockView = { kind: 'locked' }): string {
  const t = TEXT[lang];
  const h = escapeHtml;
  const paid = view.kind === 'locked' && view.paidToken && /^[A-Za-z0-9_-]{16,64}$/.test(view.paidToken) ? view.paidToken : null;
  const other = lang === 'es' ? 'en' : 'es';
  const langHref = `${base}?lang=${other}${paid ? `&pagado=${paid}` : ''}`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f1112"><title>${h(t.title)}</title><style>${CLUB_BASE_CSS}${UNLOCK_CSS}</style></head><body><main>`
    + `<div class="top">${brandWordmark()}<a class="lang" href="${h(langHref)}" lang="${other}" hreflang="${other}" aria-label="${h(t.otherLabel)}">${h(t.other)}</a></div>`
    + body(view, t)
    + `</main>${view.kind === 'locked' ? unlockScript(base, lang, t, paid) : ''}</body></html>`;
}
