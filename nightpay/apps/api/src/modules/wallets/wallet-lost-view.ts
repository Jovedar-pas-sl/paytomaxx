import { escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/pay-i18n';
import { WALLET_TEXT } from './wallet-text';

/**
 * «He perdido mi NFC» en la página del saldo (/w/:token), maqueta 5.2: el
 * botón rojo (solo con NFC dado y Face ID activado) y la hoja que lo bloquea
 * con su Face ID. El saldo no se pierde: se dice con su importe y su código.
 * «Bloquear», junto al número de la ficha en la tarjeta del saldo (idea 69),
 * sale con la misma regla y abre la misma hoja.
 * Lo usa wallet-page.ts (define $, T, S, busy, post, openSheet…).
 *
 * El JS va dentro de plantillas de TypeScript: sin barras invertidas.
 */

const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const FACE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0"/></svg>';

export const LOST_CSS = `
.btn.redo svg,.btn.red svg{width:1.4rem;height:1.4rem;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.btn.redo{min-height:3rem;background:var(--surface-2);color:var(--err);border-color:var(--bad);box-shadow:inset 0 1px 0 rgba(239,233,223,.08);font-weight:500}
.btn.red{background:var(--fail);border-color:var(--fail);color:var(--paid-ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
.lockc{align-self:center;width:4rem;height:4rem;border-radius:50%;display:grid;place-items:center;background:rgb(255 107 107/.12);color:var(--bad)}
.lockc svg{width:2rem;height:2rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#lostSheet{text-align:left}
#lostSheet h2{text-align:left}
.safe{padding:.8rem 1rem;border-radius:var(--r-tile);border:1px solid var(--line);background:var(--surface-2);color:var(--fg)}
`;

/** El botón, debajo de «Más» (lo enseña el JS). */
export function lostButton(lang: PayLanguage): string {
  return `<button class="btn redo" type="button" id="lostOpen" hidden>${LOCK_ICON}<span>${escapeHtml(WALLET_TEXT[lang].lostButton)}</span></button>
<p class="small" id="lostAsk" hidden>${escapeHtml(WALLET_TEXT[lang].lostAsk)}</p>\n`;
}

/** La hoja: por qué, que el saldo no se pierde, «Bloquear con Face ID» y «No, lo tengo» (el foco empieza en la opción que no bloquea). */
export function lostSheet(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<dialog class="sheet" id="lostSheet" aria-labelledby="lostTitle">
<span class="lockc">${LOCK_ICON}</span>
<h2 id="lostTitle">${h(t.lostTitle)}</h2><p>${h(t.lostWhy)}</p>
<p class="safe" id="lostSafe"></p>
<p class="err" id="lostErr" role="alert" hidden></p>
<button class="btn red" type="button" id="lostGo">${FACE_ICON}<span id="lostGoLabel">${h(t.lostGo)}</span></button>
<button class="link" type="button" data-close autofocus>${h(t.lostKeep)}</button>
</dialog>
`;
}

/**
 * lostRender(s): el botón sale con NFC dado y Face ID, en un saldo vivo (o
 * gastado) y sin devolución en marcha. Al confirmar: reto de /lost-nfc, Face
 * ID y el estado nuevo del saldo (ya sin NFC).
 */
export const LOST_JS = `
function lostRender(s){var can=s.hasCard&&!s.merged&&!s.refund&&(s.status==='ACTIVE'||s.status==='DEPLETED');$('lostOpen').hidden=!(can&&s.hasFaceId);$('lostQuick').hidden=!(can&&s.hasFaceId);$('lostAsk').hidden=!(can&&!s.hasFaceId);}
function lostLabel(text){$('lostGoLabel').textContent=text;}
$('lostOpen').addEventListener('click',function(){
 $('lostSafe').textContent=fill(fill(T.lostSafe,'amount',eur(S.balanceCents)),'code',S.code);
 show('lostErr','');openSheet($('lostSheet'));});
$('lostQuick').addEventListener('click',function(){$('lostOpen').click();});
$('lostGo').addEventListener('click',function(){var b=$('lostGo');if(busy)return;show('lostErr','');
 if(!pkSupported()){show('lostErr',T.faceIdNeeded);return;}
 busy=true;b.disabled=true;lostLabel(T.unlockWaiting);
 pkGet(C.base+'/lost-nfc/challenge').then(function(k){return post('/lost-nfc',{response:k});})
  .then(function(s){render(s);closeSheet($('lostSheet'));toast(T.lostDone);})
  .catch(function(e){if(!pkCancelled(e))show('lostErr',msg(e));})
  .then(function(){busy=false;b.disabled=false;lostLabel(T.lostGo);});});`;
