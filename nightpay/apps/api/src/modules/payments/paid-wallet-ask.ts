import { escapeHtml, jsConfig } from './club-ui';
import type { PayText } from './pay-i18n';
import { PASSKEY_BROWSER_JS } from '../wallets/passkey-browser';
import { CLIENT_ERROR_JS, clientErrorConfig } from '../wallets/client-errors';

/**
 * Debajo del «Pagado» de la recarga que creó el saldo, en el móvil que pagó:
 * UNA pregunta, activar el pago desbloqueando el móvil (Face ID en iPhone,
 * huella o bloqueo de pantalla en Android), con «Ahora no». Primero se
 * explica para qué sirve y después se confirma. El PIN y sumar la recarga a
 * otro saldo están en la página del saldo (/w), como acciones secundarias.
 *
 * Los textos de cada plataforma los pone el JS (sabe qué móvil es); sin JS
 * no se puede activar, así que la pregunta empieza oculta.
 */
export interface WalletBlock {
  hasFaceId: boolean;
  /** /pay/:token: a esta ruta se le añaden /passkey/options y /passkey. */
  base: string;
}

export const WALLET_ASK_CSS = `
.next{width:100%;max-width:26rem;margin:0 auto;padding:1rem 1rem calc(1.5rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;gap:.9rem;text-align:center}
.ask{width:100%;border:2px solid var(--line);border-radius:var(--r);padding:1.25rem 1.1rem 1rem;background:var(--surface);display:flex;flex-direction:column;align-items:center;gap:.7rem}
.ask h2{font-size:1.45rem;line-height:1.2}
.ask .kick{color:var(--lime)}
`;

function unlockJsText(t: PayText): Record<string, unknown> {
  return {
    unlock: t.unlock,
    unlockWhy: t.unlockWhy,
    unlockWaiting: t.unlockWaiting,
    unlockAfter: t.unlockAfter,
    unlockUnsupported: t.unlockUnsupported,
    notNowAfter: t.notNowAfter,
  };
}

/** La pregunta de activar el desbloqueo (sin el botón del saldo ni el justificante). */
export function renderWalletAsk(w: WalletBlock, t: PayText): string {
  const config = jsConfig({ base: w.base, hasFaceId: w.hasFaceId, text: unlockJsText(t), errors: clientErrorConfig(t.htmlLang) });
  return `<div class="ask" id="fid" hidden>
<p class="kick">${escapeHtml(t.walletReadyTitle)}</p>
<h2 id="fidTitle"></h2>
<p id="fidWhy"></p>
<button class="btn" type="button" id="fidOn"></button>
<button class="link" type="button" id="fidLater">${escapeHtml(t.notNow)}</button>
</div>
<p class="done" id="fidDone" role="status" hidden></p>
<p id="fidNote" role="status" hidden></p>
<p class="err" id="fidErr" role="alert" hidden></p>
<script>
${PASSKEY_BROWSER_JS}
${CLIENT_ERROR_JS}
(function(){
var C=JSON.parse(${config}),T=C.text;
function $(id){return document.getElementById(id);}
function show(id,text){$(id).textContent=text;$(id).hidden=!text;}
var ua=navigator.userAgent||'',P=/iPhone|iPad|iPod/.test(ua)||(ua.indexOf('Macintosh')>-1&&navigator.maxTouchPoints>1)?'ios':ua.indexOf('Android')>-1?'android':'other',U=T.unlock[P];
function merged(){var m=$('fidMerge');if(m)m.hidden=true;}
if(C.hasFaceId){show('fidDone','✓ '+U.done+' '+T.unlockAfter);merged();return;}
if(!pkSupported()){show('fidNote',T.unlockUnsupported);return;}
$('fidTitle').textContent=U.title;$('fidWhy').textContent=T.unlockWhy;$('fidOn').textContent=U.button;$('fid').hidden=false;
$('fidLater').addEventListener('click',function(){$('fid').hidden=true;show('fidNote',T.notNowAfter);});
$('fidOn').addEventListener('click',function(){var b=$('fidOn');if(b.disabled)return;
 b.disabled=true;b.textContent=T.unlockWaiting;show('fidErr','');
 pkCreate(C.base+'/passkey/options').then(function(k){return pkPost(C.base+'/passkey',{response:k});})
  .then(function(){$('fid').hidden=true;merged();show('fidDone','✓ '+U.done+' '+T.unlockAfter);})
  .catch(function(e){b.disabled=false;b.textContent=U.button;if(!pkCancelled(e))show('fidErr',npErr(e,C.errors));});});
})();
</script>`;
}
