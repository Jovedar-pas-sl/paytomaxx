import { DETAIL_TIP_AND_FEE_APART } from '@nightpay/contracts';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { CLUB_BASE_CSS, MONEY_JS, clientMoney, escapeHtml, jsConfig } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../payments/customer-chrome';
import type { ClientWalletState } from './wallet-charges.service';
import { PASSKEY_BROWSER_JS } from './passkey-browser';
import { CLIENT_ERROR_JS, clientErrorConfig } from './client-errors';
import { WALLET_TEXT } from './wallet-text';
import { GOOGLE_WALLET_BUTTONS } from './google-wallet/google-wallet-button';
import type { TopUpOptions, TopUpProof } from './wallet-topup.service';
import { TOPUP_CSS, TOPUP_JS, paidProofScript, paidProofSection, topUpCard, topUpOffNote } from './wallet-topup-view';
import { SCAN_CSS, SCAN_JS, scanArea } from './wallet-scan';
import { LOST_CSS, LOST_JS, lostButton, lostSheet } from './wallet-lost-view';
import { WALLET_LIVE_JS } from './wallet-live';
import { myBalanceButton, myBalanceScript } from './my-balance';
import { RECEIPT_JS, WELCOME_CSS, WELCOME_JS, fichaQrBlock, welcomeCard } from '../home-topup/wallet-welcome-view';
import type { PartyPageData } from '../party/party-refunds.service';
import {
  PARTY_CSS,
  PARTY_JS,
  PARTY_THEME_COLOR,
  partyActions,
  partyJsConfig,
  partyNote,
  partySheets,
  partyTopBar,
} from '../party/party-wallet-view';

/**
 * Página del saldo del cliente (/w/:token). HTML autocontenido, Grafito: el
 * saldo va en una tarjeta plana (superficie y filete, sin verde, brillo ni
 * 0101: no imita una tarjeta de crédito) y, debajo, dos opciones iguales:
 * «Pagar» y «Recargar» (pestañas de 56 px: solo se ve una vista a la vez).
 *  - «Pagar» (la de entrada): escanear el QR del personal (con la cámara en
 *    la página si hay BarcodeDetector; si no, con la del móvil), activar el
 *    desbloqueo del móvil si falta, «Sin móvil»: el código y el PIN (o la
 *    ficha), y Google Wallet (solo Android y si está configurado).
 *  - «Recargar»: cuánto, los límites y Apple Pay / Google Pay o tarjeta
 *    (wallet-topup-view.ts). Al volver del banco se abre aquí con su «Pagado».
 *    Si el local no deja recargar, no hay opciones: solo «Pagar».
 * Debajo de las dos, «Más»: elegir PIN, juntar saldos, «Me voy» (en hojas
 * dentro de la página: nada de confirm()/alert()) y los movimientos (tocar
 * uno abre su «Detalle del pago»; uno deshecho dice «Devuelto a tu saldo»). El
 * estado se pone al día al momento: la página escucha los avisos de su saldo
 * (GET /w/:token/events) y solo entonces pide /state; de respaldo, cada
 * 20–30 s, y «Reconectando…» si no lo consigue (wallet-live.ts). Aquí no se
 * cobra: se paga en la página del cobro (/s/…) o con el PIN en el móvil del
 * personal.
 * Todo texto dinámico va con textContent (nada de HTML inyectado).
 */

const WALLET_CSS = `
.w{max-width:26rem;margin:0 auto;padding:1rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.w>.top{padding:0}
.hero{min-height:8.75rem;padding:1rem 1.125rem;border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;text-align:left;color:var(--fg);background:var(--surface)}
#balanceLabel{font-size:.8125rem;font-weight:500;color:var(--mute)}
.hero .obot{display:flex;justify-content:space-between;gap:.5rem;font-size:.875rem;font-weight:600;color:var(--fg)}
.balance{font-size:3.5rem;font-weight:600;letter-spacing:-.02em;line-height:1;margin-top:.25rem;color:var(--fg);font-variant-numeric:proportional-nums}
.status{font-weight:500;color:var(--fg)}
.hero .mine{display:grid;gap:.375rem}.hero .mine:has(#npMine[hidden]){display:none}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.segb{display:flex;align-items:center;justify-content:center;gap:.5rem;min-height:3.5rem;padding:.5rem .75rem;border:1px solid var(--line-hi);border-radius:var(--r-btn);background:var(--surface-2);color:var(--fg);font:inherit;font-size:1.0625rem;font-weight:600;line-height:1.1;cursor:pointer;transition:transform .15s var(--ease)}
.segb svg{width:1.25rem;height:1.25rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.segb[aria-selected=true]{border-color:var(--fg);background:var(--fg);color:var(--ink-0)}
.segb:active{transform:scale(.98)}
.segb:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.view{display:flex;flex-direction:column;gap:1rem}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1rem;display:flex;flex-direction:column;gap:.75rem;background:var(--surface)}
.card h2{font-size:1.125rem;line-height:1.25}
.card h2.kick{font-size:.8125rem}
.card h2.sub{font-size:1rem}
.card.main{border-color:var(--line-hi)}
.how{color:var(--fg)}
.code{font-size:2rem;font-weight:700;letter-spacing:.2em;color:var(--fg);text-align:center}
.small{font-size:.875rem}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:.4rem;text-align:center}
.steps li{display:flex;flex-direction:column;align-items:center;gap:.3rem;font-size:.8125rem;font-weight:500;color:var(--dim)}
.steps li::before{content:'○';display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;border:2px solid var(--line);font-size:.875rem}
.steps li.ok{color:var(--fg)}
.steps li.ok::before{content:'✓';border-color:var(--fg);background:var(--fg);color:var(--bg)}
.steps li.now{color:var(--fg);font-weight:600}
.steps li.now::before{content:'●';border-color:var(--fg)}
.more{display:flex;flex-direction:column;gap:.25rem;margin-top:.5rem}
.rows{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.row{display:flex;flex-direction:column;align-items:flex-start;gap:.1rem;width:100%;min-height:3.25rem;padding:.625rem .25rem;border:0;border-bottom:1px solid var(--line);background:none;color:var(--fg);font:inherit;font-weight:500;text-align:left;cursor:pointer}
.row small{font-weight:400;color:var(--mute);font-size:.8125rem}
.row:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.row[aria-expanded]{position:relative;padding-right:2rem}
.row[aria-expanded]::after{content:'+';position:absolute;right:.5rem;top:50%;transform:translateY(-50%);font-size:1.25rem;color:var(--mute)}
.row[aria-expanded=true]::after{content:'−'}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
li.mv{display:flex;align-items:center;gap:.75rem;padding:.55rem 0;border-bottom:1px solid var(--line);font-size:.9375rem}
li.mv .sw{align-self:stretch;flex:none;width:4px;min-height:2.4rem;border-radius:2px;background:var(--c,var(--dim))}
li.mv .sw.hold{background:repeating-linear-gradient(var(--dim) 0 6px,transparent 6px 10px)}
li.mv .mt{flex:1;min-width:0}
li.mv .mt b{display:block;color:var(--fg);font-size:1rem;font-weight:500}
li.mv .mt span{display:block;color:var(--mute);font-size:.8125rem}
li.mv .plus{color:var(--ok);font-weight:600;white-space:nowrap}
li.mv .minus{color:var(--fg);font-weight:600;white-space:nowrap}
li.mv .gone{color:var(--mute);font-weight:500;white-space:nowrap;text-decoration:line-through}
.mvb{display:flex;align-items:center;gap:.75rem;width:100%;min-height:2.75rem;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mvb:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.det{display:flex;flex-direction:column;margin:0;text-align:left}
.det div{display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--line)}
.det dt{color:var(--mute)}
.det dd{margin:0;text-align:right;font-weight:500;overflow-wrap:anywhere}
.det-total{font-size:2rem;font-weight:600;line-height:1.1}
dialog.sheet{position:fixed;inset:auto 0 0 0;width:100%;max-width:30rem;max-height:92vh;margin:0 auto;overflow:auto;border:0;border-top:1px solid var(--line-hi);border-radius:var(--r) var(--r) 0 0;padding:1.5rem 1rem calc(1.25rem + env(safe-area-inset-bottom));background:var(--surface);color:var(--fg);box-shadow:var(--sh-sheet);display:none;flex-direction:column;gap:.75rem;text-align:center}
dialog.sheet[open]{display:flex;animation:np-up .28s var(--ease)}
dialog.sheet::backdrop{background:var(--scrim)}
dialog.sheet h2{font-size:1.375rem}
@keyframes np-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes np-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){dialog.sheet[open]{animation:np-in .2s ease}}
.pins{display:flex;gap:.5rem;justify-content:center}
.pins input{width:7.5rem;min-height:3.25rem;font:inherit;font-size:1.375rem;text-align:center;border-radius:var(--r-field);border:1px solid var(--line-hi);background:var(--surface-2);color:var(--fg);letter-spacing:.3em}
.pins input:focus-visible{outline:3px solid var(--lime);outline-offset:2px}
.pins input::placeholder{letter-spacing:normal;font-size:1rem;color:var(--dim)}
.gw{display:flex;flex-direction:column;align-items:center;gap:.5rem;padding:.5rem 0;text-align:center}
.gwb{display:block;max-width:100%;padding:0;margin:.5rem 0;border:0;border-radius:28px;background:none;line-height:0;cursor:pointer}
.gwb img{display:block;height:3.5rem;width:auto;max-width:100%;object-fit:contain}
.gwb:focus-visible{outline:3px solid var(--fg);outline-offset:3px}
.gwb:disabled{cursor:progress}
.live{align-self:center;display:flex;align-items:center;gap:.5rem;padding:.375rem .75rem;border-radius:var(--r-chip);border:1px solid var(--line-hi);background:var(--surface-2);color:var(--fg);font-size:.875rem;font-weight:500}
.live::before{content:'';width:.5rem;height:.5rem;border-radius:50%;background:var(--warn);animation:np-pulse 1.2s ease-in-out infinite}
@keyframes np-pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.live::before{animation:none}}
.toast{position:fixed;left:1rem;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom));max-width:26rem;margin:0 auto;padding:.875rem 1rem;border-radius:var(--r-tile);background:var(--fg);color:var(--bg);font-weight:500;text-align:center;box-shadow:var(--sh-dialog);z-index:10;animation:np-in .2s ease}
`;

/** Iconos de las dos opciones (decorativos: el texto dice lo que es). */
const PAY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18h2"/></svg>';
const TOPUP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>';

/** «26 €», «26,50 €» (sin «,00», como en el móvil del personal). */
function eur(cents: number, locale: string): string {
  return clientMoney(cents, locale);
}

/** Textos que necesita el JS de la página (los del desbloqueo, de pay-i18n). */
function jsText(lang: PayLanguage): Record<string, unknown> {
  const p = PAY_TEXT[lang];
  return {
    ...WALLET_TEXT[lang],
    unlock: p.unlock,
    unlockWaiting: p.unlockWaiting,
  };
}

export interface WalletPageOptions {
  /** Google Wallet configurado: el botón oficial sale (solo en Android). */
  googleWallet?: boolean;
  /** «Recargar»: si se puede ahora y con qué importes (sin esto, no sale). */
  topUp?: TopUpOptions | null;
  /** Vuelta del banco tras pagar una recarga de este saldo: su «Pagado». */
  paid?: TopUpProof | null;
  /** Hora del servidor (para el «Pagado»). */
  now?: Date;
  /**
   * Sin Face ID: la vía del móvil que pagó la recarga que creó el saldo
   * (/pay/<cobro>: su cookie del pago) para activar Face ID o elegir el primer
   * PIN. null: no la hay, y la página dice que pida el QR de activación (M-2).
   */
  payer?: string | null;
  /**
   * Saldo nuevo cargado desde casa (?nuevo=<cobro>, «Cargar saldo antes de
   * llegar»): su «Pagado» arriba con la bienvenida, y la página en «Pagar».
   */
  welcome?: boolean;
  /** El QR de la ficha (SVG): sin ficha aún, recepción lo escanea para darle una. */
  fichaQr?: string | null;
  /**
   * OxioParty (EDITION=party): la página de la pulsera, de día, con la marca,
   * Recargar / «Lo que sobra» / «La perdí», las casetas y el plazo
   * (party/party-wallet-view.ts). Sin esto, la de OxioPay tal cual.
   */
  party?: PartyPageData | null;
}

/**
 * «Añadir a Google Wallet» en «Pagar»: solo en Android, con el botón oficial
 * servido desde nuestro dominio (sin dibujarlo ni retocarlo: alto mínimo
 * 48 dp y 8 dp libres alrededor, normas de marca de Google).
 */
function googleWalletSection(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const b = GOOGLE_WALLET_BUTTONS[lang];
  const h = escapeHtml;
  return `<section class="gw" id="gwCard" hidden aria-label="Google Wallet">
<button class="gwb" type="button" id="gwAdd"><img src="/w/assets/google-wallet/${lang}" width="${b.width}" height="${b.height}" alt="${h(b.alt)}"></button>
<p class="small" id="gwMsg" role="status">${h(t.gwHint)}</p>
<p class="err" id="gwErr" role="alert" hidden></p>
</section>
`;
}

/**
 * Al tocarlo: el API prepara el pase y devuelve el enlace de Google para
 * guardarlo. Solo se abre si es de verdad de Google (pay.google.com).
 */
const GOOGLE_WALLET_JS = `
$('gwAdd').addEventListener('click',function(){var b=$('gwAdd');if(busy)return;busy=true;b.disabled=true;
 $('gwMsg').textContent=T.gwPreparing;show('gwErr','');
 post('/google-wallet').then(function(r){var u=r&&r.saveUrl;
   if(typeof u==='string'&&u.indexOf('https://pay.google.com/gp/v/save/')===0)location.href=u;else show('gwErr',T.error);})
  .catch(function(e){show('gwErr',msg(e));})
  .then(function(){busy=false;b.disabled=false;$('gwMsg').textContent=T.gwHint;});});`;

/** «Pagar» / «Recargar»: pestañas (las enseña el JS solo si se puede recargar). */
function viewTabs(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<div class="seg" role="tablist" id="seg" aria-label="${h(t.views)}" hidden>
<button class="segb" type="button" role="tab" id="tabPay" aria-controls="viewPay" aria-selected="true">${PAY_ICON}${h(t.pay)}</button>
<button class="segb" type="button" role="tab" id="tabTop" aria-controls="viewTop" aria-selected="false" tabindex="-1">${TOPUP_ICON}${h(t.topUp)}</button>
</div>
`;
}

/** Vista «Pagar»: el QR del personal (o activar el desbloqueo), sin móvil y Google Wallet. */
function payView(lang: PayLanguage, state: ClientWalletState, gw: boolean, fichaQr: string | null): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<section class="view" id="viewPay" aria-labelledby="tabPay">
<section class="card main" id="payCard" hidden aria-labelledby="payTitle">
<h2 id="payTitle">${h(t.scanTitle)}</h2>
<div class="stack" id="faceCard" hidden><p id="faceWhy">${h(t.payFaceWhy)}</p>
<button class="btn" type="button" id="faceOn"></button>
<p class="err" id="faceErr" role="alert" hidden></p></div>
${scanArea(lang)}</section>
<section class="card how" id="howCard" hidden><p class="how" id="howText"></p></section>
<p class="how" id="payEmpty" hidden>${h(t.payEmpty)}</p>
<section class="card" id="codeCard" aria-labelledby="codeTitle"><h2 class="sub" id="codeTitle">${h(t.codeTitle)}</h2><p class="code num" id="code">${h(state.code)}</p>
<p class="small" id="codeHint"></p><p class="small" id="fichaHint" hidden>${h(t.codeFicha)}</p>${fichaQr ? fichaQrBlock(lang, fichaQr) : ''}</section>
${gw ? googleWalletSection(lang) : ''}</section>
`;
}

/** Vista «Recargar»: el «Pagado» si vuelve del banco y cuánto recargar. */
function topUpView(lang: PayLanguage, options: WalletPageOptions): string {
  // La bienvenida del saldo cargado desde casa lleva su «Pagado» arriba, no aquí.
  const proof = options.welcome ? null : (options.paid ?? null);
  return `<section class="view" id="viewTop" aria-labelledby="tabTop" hidden>
${proof ? paidProofSection(lang, proof, options.now ?? new Date()) : ''}${topUpCard(lang, options.topUp ?? null)}</section>
`;
}

/** «Más»: lo que no es pagar ni recargar (las hojas y los movimientos). */
function moreList(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<section class="more" id="more" aria-labelledby="moreTitle">
<h2 class="kick" id="moreTitle">${h(t.more)}</h2>
<div class="rows">
<button class="row" type="button" id="pinOpen" hidden>${h(t.pinRow)}<small>${h(t.pinRowHint)}</small></button>
<button class="row" type="button" id="mergeOpen" hidden>${h(t.mergeRow)}<small>${h(t.mergeRowHint)}</small></button>
<button class="row" type="button" id="leaveOpen" hidden>${h(t.leaveRow)}<small>${h(t.leaveRowHint)}</small></button>
<button class="row" type="button" id="movOpen" aria-expanded="true" aria-controls="movBox">${h(t.movements)}<small>${h(t.movementsHint)}</small></button>
<div id="movBox"><ul id="movements"></ul></div>
</div>
</section>
${lostButton(lang)}`;
}

/**
 * Las dos vistas: setView('pay'|'top') enseña una (y su pestaña marcada);
 * segShow(on) enseña o quita las pestañas (sin ellas, solo «Pagar»). Flechas,
 * Inicio y Fin cambian de pestaña (patrón de pestañas de WAI-ARIA).
 */
const VIEWS_JS = `
var view=C.paid?'top':'pay';
function setView(v,focus){var pay=v!=='top';view=pay?'pay':'top';
 $('tabPay').setAttribute('aria-selected',String(pay));$('tabTop').setAttribute('aria-selected',String(!pay));
 $('tabPay').tabIndex=pay?0:-1;$('tabTop').tabIndex=pay?-1:0;
 $('viewPay').hidden=!pay;$('viewTop').hidden=pay;
 if(!pay){if(SC.on)scanStop();topOpen();}
 if(focus)$(pay?'tabPay':'tabTop').focus();}
function segShow(on){var was=!$('seg').hidden;$('seg').hidden=!on;
 ['viewPay','viewTop'].forEach(function(id){if(on)$(id).setAttribute('role','tabpanel');else $(id).removeAttribute('role');});
 if(!on&&view==='top')setView('pay');else if(on&&!was)setView(view);}
$('tabPay').addEventListener('click',function(){setView('pay');});
$('tabTop').addEventListener('click',function(){setView('top');});
$('seg').addEventListener('keydown',function(e){var k=e.key,to=k==='Home'?'pay':k==='End'?'top':k==='ArrowLeft'||k==='ArrowRight'?(view==='pay'?'top':'pay'):'';
 if(!to)return;e.preventDefault();setView(to,true);});
$('movOpen').addEventListener('click',function(){var b=$('movOpen'),open=b.getAttribute('aria-expanded')!=='true';
 b.setAttribute('aria-expanded',String(open));$('movBox').hidden=!open;});`;

export function renderWalletPage(
  token: string,
  lang: PayLanguage,
  state: ClientWalletState,
  options: WalletPageOptions = {},
): string {
  const t = WALLET_TEXT[lang];
  const base = `/w/${encodeURIComponent(token)}`;
  const gw = options.googleWallet === true;
  const proof = options.paid ?? null;
  const welcome = options.welcome === true && proof !== null;
  const topUp = options.topUp ?? null;
  const party = options.party ?? null;
  const config = jsConfig({
    base,
    lang,
    locale: t.locale,
    text: jsText(lang),
    errors: clientErrorConfig(lang),
    state,
    gw,
    topUp,
    paid: proof !== null && !welcome,
    welcome,
    payer: options.payer ?? null,
    // «Detalle del pago»: propina y comisión del servicio cada una en su línea.
    apart: DETAIL_TIP_AND_FEE_APART,
    ...(party ? { party: partyJsConfig(lang, party) } : {}),
  });
  const h = escapeHtml;
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="${party ? PARTY_THEME_COLOR : '#0b0d0e'}"><title>${h(t.title)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${WALLET_CSS}${SCAN_CSS}${TOPUP_CSS}${LOST_CSS}${WELCOME_CSS}${party ? PARTY_CSS : ''}</style></head><body><main class="w">
${party ? partyTopBar(lang, party) : topBar(lang)}<h1 class="sr">${h(t.title)}</h1>
<section class="hero" aria-labelledby="balanceLabel">
<p id="balanceLabel">${h(state.venueName ? t.balanceOf.split('{venue}').join(state.venueName) : t.balance)}</p>
<p class="balance num" id="balance" aria-live="polite">${h(eur(state.balanceCents, t.locale))}</p>
<p class="status" id="notice" role="status" hidden></p>
<div class="mine">${myBalanceButton(lang)}</div>
<div class="obot"><span class="num" id="heroCode">${h(state.code)}</span><span id="heroFicha">${state.hasCard && state.fichaNumber ? h(t.fichaNo.split('{n}').join(state.fichaNumber)) : ''}</span></div>
</section>
<p class="live" id="liveBar" role="status" hidden></p>
${party ? partyActions(lang) : ''}${welcome && proof ? `${paidProofSection(lang, proof, options.now ?? new Date())}${welcomeCard(lang, state.venueName, proof, state.code, Boolean(options.fichaQr))}` : ''}${topUpOffNote()}<section class="card main" id="refundCard" hidden aria-labelledby="refundTitle">
<h2 id="refundTitle"></h2>
<ol class="steps" id="steps">${t.steps.map((s, i) => `<li data-i="${i}">${h(s)}</li>`).join('')}</ol>
<p id="refundHow"></p>
</section>
${viewTabs(lang)}${payView(lang, state, gw, options.fichaQr ?? null)}${topUpView(lang, options)}${moreList(lang)}<p class="small">${h(t.saveHint)}</p>
${party ? partyNote() : ''}</main>
${lostSheet(lang)}${party ? partySheets(lang) : ''}<dialog class="sheet" id="leaveSheet" aria-labelledby="leaveTitle">
<h2 id="leaveTitle"></h2><p id="leaveHow"></p>
<p class="err" id="leaveErr" role="alert" hidden></p>
<button class="btn" type="button" id="leaveGo">${h(t.leaveGo)}</button>
<button class="link" type="button" data-close>${h(t.cancel)}</button>
</dialog>
<dialog class="sheet" id="pinSheet" aria-labelledby="pinTitle">
<h2 id="pinTitle">${h(t.pinTitle)}</h2><p id="pinWhy"></p>
<form id="pinForm" autocomplete="off" style="display:flex;flex-direction:column;gap:.8rem">
<div class="pins"><input id="pin1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(t.pinLabel)}" placeholder="${h(t.pinLabel)}"><input id="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(t.pinRepeat)}" placeholder="${h(t.pinRepeat)}"></div>
<p class="err" id="pinErr" role="alert" hidden></p>
<button class="btn" type="submit" id="pinGo">${h(t.pinSave)}</button>
</form>
<button class="link" type="button" data-close>${h(t.cancel)}</button>
</dialog>
<dialog class="sheet" id="mergeSheet" aria-labelledby="mergeTitle">
<h2 id="mergeTitle">${h(t.mergeTitle)}</h2><p>${h(t.mergeWhy)}</p>
<div class="pins" id="mergePinBox" hidden><input id="mergePin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="${h(t.mergePinLabel)}" placeholder="${h(t.pinLabel)}"></div>
<p class="err" id="mergeErr" role="alert" hidden></p>
<button class="btn" type="button" id="mergeGo">${h(t.mergeButton)}</button>
<button class="link" type="button" data-close>${h(t.cancel)}</button>
</dialog>
<dialog class="sheet" id="detSheet" aria-labelledby="detTitle">
<h2 id="detTitle"></h2>
<p class="det-total num" id="detTotal"></p><p id="detStatus" role="status"></p>
<dl class="det" id="detList"></dl>
<p class="err" id="detErr" role="alert" hidden></p>
<button class="link" type="button" data-close>${h(t.detail.close)}</button>
</dialog>
<p class="toast" id="toast" role="status" hidden></p>
<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
(function(){
var C=JSON.parse(${config}),T=C.text,S=C.state,busy=false,toastT;
function $(id){return document.getElementById(id);}
${MONEY_JS}
function eur(c){return npMoney(c,C.locale,'EUR');}
function fill(s,k,v){return s.split('{'+k+'}').join(v);}
function when(iso){return new Date(iso).toLocaleString(C.locale,{timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function show(id,text){$(id).textContent=text||'';$(id).hidden=!text;}
function toast(text){show('toast',text);clearTimeout(toastT);toastT=setTimeout(function(){show('toast','');},4000);}
var ua=navigator.userAgent||'',P=/iPhone|iPad|iPod/.test(ua)||(ua.indexOf('Macintosh')>-1&&navigator.maxTouchPoints>1)?'ios':ua.indexOf('Android')>-1?'android':'other',U=T.unlock[P];
function cards(){return (S.cards||[]).map(function(c){return '••'+c;}).join(' · ');}
var gw=C.gw?$('gwCard'):null;
function openSheet(d){if(d.showModal){if(!d.open)d.showModal();}else d.setAttribute('open','');}
function closeSheet(d){if(d.close&&d.open)d.close();else d.removeAttribute('open');}
Array.prototype.forEach.call(document.querySelectorAll('dialog.sheet'),function(d){
 d.addEventListener('click',function(e){if(e.target===d||e.target.hasAttribute('data-close'))closeSheet(d);});});
function busyBtn(b,on,label){b.disabled=on;b.classList.toggle('busy',on);b.textContent=on?label:b.getAttribute('data-label');}
['leaveGo','pinGo','mergeGo'].forEach(function(id){$(id).setAttribute('data-label',$(id).textContent);});
$('faceOn').textContent=U.button;$('faceOn').setAttribute('data-label',U.button);
$('pinWhy').textContent=fill(T.pinWhy,'code',S.code);
function refundView(r){
 $('refundTitle').textContent=fill(T.refundTitle,'amount',eur(r.amountCents));
 var at=r.stage==='requested'?1:r.stage==='approved'?2:3;
 Array.prototype.forEach.call($('steps').children,function(li,i){li.className=i<at?'ok':i===at?'now':'';
  if(i===at)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
 var m=r.methods,how;
 if(r.stage==='requested')how=S.cards.length?fill(T.refundRequestedCards,'cards',cards()):T.refundRequested;
 else if(r.stage==='approved')how=fill(T.refundApproved,'cards',cards());
 else how=m.length===1&&m[0]==='CASH'?T.refundDoneCash:m.length>1?fill(T.refundDoneMixed,'cards',cards()):fill(T.refundDoneCard,'cards',cards());
 $('refundHow').textContent=how;}
// «Pagar»: con el desbloqueo activado, escanear; sin él, activarlo; sin poder usarlo aquí, el PIN.
function payRender(s,active,r){var canKey=pkSupported(),payable=active&&!r;
 var setup=payable&&!s.hasFaceId&&canKey,scan=payable&&s.hasFaceId&&canKey;
 $('payCard').hidden=!(setup||scan);$('payTitle').textContent=setup?U.title:T.scanTitle;
 $('faceCard').hidden=!setup;$('scanArea').hidden=!scan;if(!scan&&SC.on)scanStop();
 $('faceOn').hidden=!C.payer;$('faceWhy').textContent=C.payer?T.payFaceWhy:T.activateAtReception;
 $('faceDone').textContent=scan?'✓ '+U.done+' '+T.payFaceDone:'';
 show('howText',payable&&!canKey?(s.hasFaceId?T.faceIdNeeded:C.payer?T.unlockUnsupported:T.activateAtReception):'');$('howCard').hidden=$('howText').hidden;
 $('codeCard').hidden=!active;show('codeHint',s.hasPin?T.codeWithPin:s.hasFaceId||C.payer?T.codeNoPin:'');$('fichaHint').hidden=!s.hasCard;
 if(gw)gw.hidden=!(P==='android'&&active&&!r&&!s.merged);}
function render(s){S=s;S.cards=s.cards||[];
 $('balance').textContent=eur(s.balanceCents);$('code').textContent=s.code;$('heroCode').textContent=s.code;
 $('heroFicha').textContent=s.hasCard&&s.fichaNumber?fill(T.fichaNo,'n',s.fichaNumber):'';
 var active=s.status==='ACTIVE',r=s.refund;
 var notice=active?'':s.status==='DEPLETED'?(s.merged?T.merged:T.depleted):r?'':T.closed;
 show('notice',notice);
 // Sumado a otro saldo: «Ver mi saldo» lleva a aquel con su Face ID (pantalla sin salida).
 window.npMineWanted=s.status==='DEPLETED'&&Boolean(s.merged);if(window.npMineShow)window.npMineShow(window.npMineWanted);
 $('refundCard').hidden=!r;if(r)refundView(r);
 payRender(s,active,r);
 $('pinOpen').hidden=!(active&&!r&&!s.hasPin&&(s.hasFaceId||C.payer));
 $('mergeOpen').hidden=!(active&&!r&&!s.hasFaceId&&!s.merged&&s.balanceCents>0&&(C.payer||s.hasPin));
 $('leaveOpen').hidden=!(active&&s.balanceCents>0&&!s.closeRequested);
 var ul=$('movements');ul.textContent='';
 if(!s.movements.length){var e=document.createElement('li');e.className='mv';e.textContent=T.noMovements;ul.appendChild(e);}
 s.movements.forEach(function(m){var li=document.createElement('li'),sw=document.createElement('i'),mt=document.createElement('span'),a=document.createElement('b'),sub=document.createElement('span'),b=document.createElement('span'),host=li;li.className='mv';
  sw.className=m.color?'sw':'sw hold';sw.setAttribute('aria-hidden','true');if(m.color)sw.style.setProperty('--c',m.color);
  mt.className='mt';${party ? 'mvText(m,a,sub);' : "a.textContent=m.labelKey&&T.mv[m.labelKey]?T.mv[m.labelKey]:m.label;sub.textContent=[m.returned?T.detail.returned:'',m.ref,m.venueName,when(m.at)].filter(Boolean).join(' · ');"}mt.appendChild(a);mt.appendChild(sub);
  b.textContent=(m.amountCents>0?'+':'')+eur(m.amountCents);b.className=(m.returned?'gone':m.amountCents>0?'plus':'minus')+' num';
  if(m.detail){host=document.createElement('button');host.type='button';host.className='mvb';host.addEventListener('click',function(){detOpen(m);});li.appendChild(host);}
  host.appendChild(sw);host.appendChild(mt);host.appendChild(b);ul.appendChild(li);});
 lostRender(s);welcomeRender(s);
 var can=topRender(s);
 $('payEmpty').hidden=!(can&&s.status==='DEPLETED');
 segShow(can||C.paid);${party ? 'partyRender(s);' : ''}}
function post(path,body){return pkPost(C.base+path,body||{});}
// «Detalle del pago»: un movimiento con detalle (lo pagado con el saldo y las recargas con tarjeta).
// Qué, cuándo, dónde, quién le cobró (su nombre de pila), cómo pagó, el código y el saldo antes y
// después; si se devolvió, cuándo (sin quién ni por qué). Nunca el móvil ni la IP.
var detSeq=0;
function detRow(k,v){if(!v)return;var d=document.createElement('div'),a=document.createElement('dt'),b=document.createElement('dd');
 a.textContent=k;b.textContent=v;d.appendChild(a);d.appendChild(b);$('detList').appendChild(d);}
function detStatus(d){var D=T.detail,s=d.status;
 if(s==='REVERSED')return D.returned;if(s==='AUTHORIZED'||s==='ACCEPTED')return D.paid;if(s==='REFUNDED')return D.refunded;
 if(s==='PARTIALLY_REFUNDED')return D.partlyRefunded;if(s==='CANCELED'||s==='EXPIRED'||s==='FAILED')return D.canceled;return D.pending;}
function detHow(m){var D=T.detail;if(!m)return '';
 if(m.method==='SALDO')return m.fichaNumber?fill(D.ficha,'n',m.fichaNumber):D.saldo;
 if(m.cardLast4)return fill(D.card,'card',[m.cardBrand,'••'+m.cardLast4].filter(Boolean).join(' '));
 return m.label&&m.label!=='—'?m.label:'';}
function detFill(d){var D=T.detail;$('detList').textContent='';
 $('detTotal').textContent=eur(d.totalCents);$('detStatus').textContent=detStatus(d);
 if(C.apart&&(d.tipCents||d.serviceFeeCents)){detRow(D.amount,eur(d.amountCents));if(d.tipCents)detRow(D.tip,eur(d.tipCents));if(d.serviceFeeCents)detRow(D.fee,eur(d.serviceFeeCents));}
 detRow(D.when,when(d.paidAt||d.createdAt));detRow(D.where,[d.venueName,d.isTopUp?T.mv.topUp:d.service].filter(Boolean).join(' · '));
 if(d.chargedBy)detRow(D.who,d.chargedBy.name);detRow(D.how,detHow(d.method));detRow(D.code,d.confirmationCode);
 if(d.balance){detRow(D.before,eur(d.balance.beforeCents));detRow(D.after,eur(d.balance.afterCents));}
 (d.undo||[]).forEach(function(u){detRow(u.kind==='REFUND'?D.undoCard:u.kind==='VOID'?D.undoSaldo:D.canceled,[typeof u.amountCents==='number'?eur(u.amountCents):'',when(u.at)].filter(Boolean).join(' · '));});}
function detOpen(m){var D=T.detail,n=++detSeq;
 $('detTitle').textContent=m.ref?D.title+' · '+m.ref:D.title;$('detTotal').textContent='';$('detStatus').textContent=D.loading;$('detList').textContent='';show('detErr','');
 openSheet($('detSheet'));
 fetch(C.base+'/movements/'+m.detail.kind+'/'+encodeURIComponent(m.detail.id),{headers:{Accept:'application/json'}})
  .then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json();})
  .then(function(d){if(n===detSeq)detFill(d);})
  .catch(function(){if(n!==detSeq)return;$('detStatus').textContent='';show('detErr',D.failed);});}
${WALLET_LIVE_JS}
// Al momento: los avisos de su saldo y, de respaldo, cada 20–30 s (wallet-live.ts).
var LV=npLive({base:C.base,busy:function(){return busy;},state:function(s){render(s);},bar:function(on){show('liveBar',on?T.reconnecting:'');},
 unauth:function(){busy=true;document.body.textContent=T.unlockWaiting;window.location.replace(C.base+'?lang='+C.lang);},
 gone:function(){busy=true;show('notice',T.linkGone);}});
function refresh(){LV.refresh();}
function msg(e){return npErr(e,C.errors);}
// Saldo con Face ID: elegir PIN y «Me voy» piden desbloquear el móvil (reto atado a la acción).
function withKey(path,body){if(!S.hasFaceId)return post(path,body);
 return pkGet(C.base+path+'/challenge').then(function(k){body.response=k;return post(path,body);});}
// Sin Face ID, el primero solo por la vía del móvil que pagó la recarga (C.payer, M-2): con
// el enlace del saldo solo, no. Si este navegador no es el que pagó, se quita y dice el QR.
function notPayer(e){if(!e||e.code!=='PAYER_ONLY')return false;C.payer=null;render(Object.assign({},S));return true;}
$('faceOn').addEventListener('click',function(){var b=$('faceOn');if(busy||!C.payer)return;busy=true;busyBtn(b,true,T.unlockWaiting);show('faceErr','');
 pkCreate(C.payer+'/passkey/options').then(function(k){return pkPost(C.payer+'/passkey',{response:k});})
  .then(function(){toast('✓ '+U.done);busy=true;window.location.replace(C.base+'?lang='+C.lang);})
  .catch(function(e){busy=false;if(!pkCancelled(e)&&!notPayer(e))show('faceErr',msg(e));})
  .then(function(){if(!busy)busyBtn(b,false);});});
$('leaveOpen').addEventListener('click',function(){
 $('leaveTitle').textContent=fill(T.leaveTitle,'amount',eur(S.balanceCents));
 $('leaveHow').textContent=S.cards.length?fill(T.leaveWaysCards,'cards',cards()):T.leaveWays;
 show('leaveErr','');openSheet($('leaveSheet'));});
$('leaveGo').addEventListener('click',function(){var b=$('leaveGo');if(busy)return;show('leaveErr','');
 if(S.hasFaceId&&!pkSupported()){show('leaveErr',T.faceIdNeeded);return;}
 busy=true;busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.sending);
 withKey('/close',{}).then(function(s){render(s);closeSheet($('leaveSheet'));toast(T.leaveDone);}).catch(function(e){if(!pkCancelled(e))show('leaveErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
$('pinOpen').addEventListener('click',function(){$('pin1').value='';$('pin2').value='';show('pinErr','');openSheet($('pinSheet'));$('pin1').focus();});
$('pinForm').addEventListener('submit',function(ev){ev.preventDefault();if(busy)return;show('pinErr','');
 var a=$('pin1').value,c=$('pin2').value;
 if(!/^[0-9]{4}$/.test(a)){show('pinErr',T.pinFormat);return;}
 if(a!==c){show('pinErr',T.pinMismatch);return;}
 if(S.hasFaceId&&!pkSupported()){show('pinErr',T.faceIdNeeded);return;}
 var b=$('pinGo');busy=true;busyBtn(b,true,S.hasFaceId?T.unlockWaiting:T.sending);
 (S.hasFaceId?withKey('/pin',{pin:a,pin2:c}):pkPost(C.payer+'/pin',{pin:a,pin2:c}).then(function(){return Object.assign({},S,{hasPin:true});}))
  .then(function(s){render(s);closeSheet($('pinSheet'));toast(T.pinDone);})
  .catch(function(e){$('pin1').value='';$('pin2').value='';if(notPayer(e))closeSheet($('pinSheet'));else if(!pkCancelled(e))show('pinErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});
// El enlace no prueba que este saldo sea suyo: lo juntan el móvil que pagó la recarga (C.payer) o quien sabe su PIN.
function mergeAsk(){$('mergePin').value='';$('mergePinBox').hidden=!!C.payer;show('mergeErr','');}
$('mergeOpen').addEventListener('click',function(){mergeAsk();openSheet($('mergeSheet'));});
$('mergeGo').addEventListener('click',function(){var b=$('mergeGo');if(busy)return;show('mergeErr','');
 var pin=$('mergePin').value,viaPayer=!!C.payer;
 if(!viaPayer&&!/^[0-9]{4}$/.test(pin)){show('mergeErr',T.pinFormat);return;}
 busy=true;busyBtn(b,true,T.unlockWaiting);
 (viaPayer?pkGet(C.payer+'/merge/challenge').then(function(k){return pkPost(C.payer+'/merge',{response:k});})
  :pkGet(C.base+'/merge/challenge').then(function(k){return post('/merge',{response:k,pin:pin});}))
  .then(function(r){closeSheet($('mergeSheet'));toast(fill(T.mergeDone,'amount',eur(r.balanceCents)));busy=false;refresh();})
  .catch(function(e){$('mergePin').value='';if(notPayer(e)){if(S.hasPin)mergeAsk();else closeSheet($('mergeSheet'));}else if(!pkCancelled(e))show('mergeErr',msg(e));})
  .then(function(){busy=false;busyBtn(b,false);});});${gw ? GOOGLE_WALLET_JS : ''}
${SCAN_JS}
${TOPUP_JS}
${LOST_JS}
${VIEWS_JS}
${party ? `${PARTY_JS}
` : ''}${welcome ? RECEIPT_JS : ''}${WELCOME_JS}
if(!C.paid&&S.status==='DEPLETED'&&topCan(S))view='top';
if(location.hash==='#recargar'&&topCan(S))view='top';
render(S);
if(C.paid||C.welcome){try{history.replaceState(null,'',C.base+'?lang='+C.lang);}catch(e){}}
if(location.hash==='#sumar'&&!$('mergeOpen').hidden){mergeAsk();openSheet($('mergeSheet'));}
LV.start();
})();
${proof ? paidProofScript(lang) : ''}
${LANG_JS}
</script>
${myBalanceScript(lang, { showIf: 'window.npMineWanted' })}</body></html>`;
}
