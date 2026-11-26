import { escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/pay-i18n';
import { WALLET_TEXT } from './wallet-text';

/**
 * «Pagar o recargar en otro sistema» en la página del saldo (/w/:token): el
 * código del móvil (`OXC1:`, 60 s, solo identifica) para que lo lea otra
 * plataforma conectada (API de socios: el cajero del local). Sale solo si
 * `liveCode` (la API encendida y una conexión que alcanza este saldo) y el
 * saldo está ACTIVE o DEPLETED, sin sumar ni devolución en marcha.
 *
 * Al tocar el botón se va y salen la placa crema (`fqri`) con el QR en un
 * <img> (su `data:` de POST /w/:token/live-code, nunca innerHTML), el aviso,
 * la nota y «Ocultar el código» (con el foco). Pide uno al tocar y cada 45 s
 * mientras se ve (con la pestaña oculta para; al volver, pide ya), hasta
 * 5 minutos: luego, «El código se ha apagado». Ocultar deja de pedir y
 * devuelve el botón con el foco. Sin JS el bloque no sale (`hidden`).
 *
 * Lo usa wallet-page.ts (define $, T, C, show, post, msg). El JS va dentro de
 * plantillas de TypeScript: sin barras invertidas.
 */

export const LIVE_CODE_CSS = `
.lc .btn.alt{min-height:3rem;width:100%}
.lc .link{min-height:2.75rem}
.lcq{display:flex;flex-direction:column;align-items:center;gap:.75rem;text-align:center}
.lc .fqri{width:15rem;max-width:72%;box-sizing:border-box}
.fqri img{display:block;width:100%;height:auto}
.lcw{color:var(--fg);font-weight:500}
`;

/** El bloque, oculto hasta que el JS lo enseña (entre «Pagar»/«Recargar» y «Más»). */
export function liveCodeCard(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang].liveCode;
  const h = escapeHtml;
  return `<section class="card lc" id="lcCard" hidden aria-label="${h(t.button)}">
<p class="small" id="lcHint">${h(t.hint)}</p>
<button class="btn alt" type="button" id="lcOpen">${h(t.button)}</button>
<div class="lcq" id="lcBox" hidden>
<div class="fqri" id="lcPlate" hidden><img id="lcImg" alt="${h(t.alt)}" width="240" height="240"></div>
<p class="lcw">${h(t.warn)}</p>
<p class="small">${h(t.note)}</p>
<button class="link" type="button" id="lcHide">${h(t.hide)}</button>
</div>
<p class="small" id="lcMsg" role="status" hidden></p>
</section>
`;
}

/**
 * liveCodeRender(s), desde render(s): el bloque sale o no; si deja de valer
 * con el código a la vista, se quita y deja de pedir. lcStop devuelve el foco
 * al botón si estaba en «Ocultar el código» (o al tocarlo: en iPhone tocar no
 * enfoca). `seq` descarta la
 * respuesta que llega tras ocultar (o con la pestaña oculta).
 */
export const LIVE_CODE_JS = `
var LC={on:false,seq:0,t:0,stopT:0};
function liveCodeRender(s){var can=Boolean(C.liveCode)&&!s.merged&&!s.refund&&(s.status==='ACTIVE'||s.status==='DEPLETED');
 $('lcCard').hidden=!can;if(!can&&LC.on)lcStop('');}
function lcStop(text,focus){var had=focus||document.activeElement===$('lcHide');LC.on=false;LC.seq++;clearTimeout(LC.t);clearTimeout(LC.stopT);LC.t=0;LC.stopT=0;
 $('lcBox').hidden=true;$('lcPlate').hidden=true;$('lcImg').removeAttribute('src');$('lcOpen').hidden=false;show('lcMsg',text);
 if(had)$('lcOpen').focus();}
function lcErr(e){return !e||!e.status||e.status>=500?C.errors.TRY_LATER:msg(e);}
function lcAsk(){if(!LC.on)return;clearTimeout(LC.t);LC.t=0;if(document.visibilityState==='hidden')return;
 var n=++LC.seq;
 post('/live-code').then(function(r){if(n!==LC.seq||!LC.on)return;var q=r&&r.qr;
   if(typeof q!=='string'||q.indexOf('data:image/svg+xml;base64,')!==0)throw new Error('qr');
   $('lcImg').src=q;$('lcPlate').hidden=false;show('lcMsg','');LC.t=setTimeout(lcAsk,45000);})
  .catch(function(e){if(n===LC.seq&&LC.on)lcStop(lcErr(e));});}
$('lcOpen').addEventListener('click',function(){if(LC.on)return;LC.on=true;
 $('lcOpen').hidden=true;$('lcBox').hidden=false;show('lcMsg',T.liveCode.loading);
 $('lcHide').focus();$('lcBox').scrollIntoView({block:'nearest'});
 LC.stopT=setTimeout(function(){lcStop(T.liveCode.ended);},300000);lcAsk();});
$('lcHide').addEventListener('click',function(){lcStop('',true);});
document.addEventListener('visibilitychange',function(){if(!LC.on)return;
 if(document.visibilityState==='hidden'){LC.seq++;clearTimeout(LC.t);LC.t=0;}else lcAsk();});`;
