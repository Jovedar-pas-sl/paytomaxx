import { escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/pay-i18n';
import { WALLET_TEXT } from './wallet-text';

/**
 * «Escanear QR» en «Pagar» de la página del saldo (/w/:token): la cámara
 * dentro de la página con BarcodeDetector (Chrome en Android). Solo se va a
 * una página de cobro NUESTRA (/s/<payToken> de este mismo dominio); otro QR
 * se ignora con un aviso. Sin BarcodeDetector (Safari del iPhone) no hay
 * botón: se dice que abra la cámara del móvil (lee el QR y abre /s/…).
 *
 * La cámara se apaga al cerrar, al cambiar a «Recargar», al salir de la
 * página o al esconderla. El JS va dentro de plantillas de TypeScript: sin
 * barras invertidas (y sin expresiones con barras: split/join y RegExp de
 * texto).
 */

export const SCAN_CSS = `
.stack{display:flex;flex-direction:column;gap:.7rem}
.scanbox{position:relative;overflow:hidden;border-radius:var(--r-tile);background:var(--ink-0);aspect-ratio:1/1;max-height:60vh}
.scanbox video{display:block;width:100%;height:100%;object-fit:cover}
.scanbox::after{content:'';position:absolute;inset:15%;border:3px solid var(--lime);border-radius:18px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none}
`;

/** Lo de escanear dentro de la tarjeta de «Pagar» (lo enseña el JS si hay Face ID). */
export function scanArea(lang: PayLanguage): string {
  const t = WALLET_TEXT[lang];
  const h = escapeHtml;
  return `<div class="stack" id="scanArea" hidden>
<button class="btn" type="button" id="scanGo" hidden>${h(t.scanButton)}</button>
<p class="how" id="scanAlt" hidden>${h(t.scanCamera)}</p>
<div class="scanbox" id="scanBox" hidden><video id="scanVideo" playsinline muted aria-label="${h(t.scanAim)}"></video></div>
<p class="how" id="scanMsg" role="status" hidden></p>
<p class="err" id="scanErr" role="alert" hidden></p>
<button class="btn alt" type="button" id="scanStop" hidden>${h(t.scanStop)}</button>
<p class="small" id="faceDone"></p>
</div>
`;
}

/**
 * JS del escáner (dentro del JS de la página: usa $, show, C y T).
 *  - chargePath(texto): '/s/<token>' si es un cobro de este dominio; si no, null.
 *  - scanStop(): apaga la cámara (la llama la página al cambiar de vista).
 */
export const SCAN_JS = `
var SC={on:false,stream:null,timer:0,det:null,last:''},TOKEN=new RegExp('^[A-Za-z0-9_-]{16,128}$');
var scanOk=typeof window.BarcodeDetector==='function'&&!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);
function chargePath(raw){var u;try{u=new URL(String(raw||'').trim());}catch(e){return null;}
 if(u.origin!==location.origin)return null;
 var p=u.pathname.split('/');if(p.length===4&&p[3]==='')p.pop();
 return p.length===3&&p[0]===''&&p[1]==='s'&&TOKEN.test(p[2])?'/s/'+p[2]:null;}
function scanAvail(){$('scanGo').hidden=!scanOk||SC.on;$('scanAlt').hidden=scanOk;}
function scanStop(){SC.on=false;clearTimeout(SC.timer);
 if(SC.stream){SC.stream.getTracks().forEach(function(k){k.stop();});SC.stream=null;}
 $('scanVideo').srcObject=null;$('scanBox').hidden=true;$('scanStop').hidden=true;show('scanMsg','');scanAvail();}
function scanTick(){if(!SC.on)return;var v=$('scanVideo');
 if(v.readyState<2){SC.timer=setTimeout(scanTick,200);return;}
 SC.det.detect(v).then(function(codes){if(!SC.on)return;
   for(var i=0;i<codes.length;i++){var to=chargePath(codes[i].rawValue);
    if(to){scanStop();show('scanMsg',T.scanOpening);location.href=to+'?lang='+C.lang;return;}}
   if(codes.length&&codes[0].rawValue!==SC.last){SC.last=codes[0].rawValue;show('scanMsg',T.scanWrong);}
   SC.timer=setTimeout(scanTick,250);})
  .catch(function(){if(SC.on)SC.timer=setTimeout(scanTick,500);});}
$('scanGo').addEventListener('click',function(){if(SC.on)return;show('scanErr','');SC.last='';
 try{SC.det=SC.det||new window.BarcodeDetector({formats:['qr_code']});}catch(e){show('scanErr',T.scanFailed);return;}
 SC.on=true;scanAvail();$('scanBox').hidden=false;$('scanStop').hidden=false;show('scanMsg',T.scanAim);
 navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}).then(function(st){
   if(!SC.on){st.getTracks().forEach(function(k){k.stop();});return;}
   SC.stream=st;var v=$('scanVideo');v.srcObject=st;var pl=v.play();if(pl&&pl.catch)pl.catch(function(){});scanTick();})
  .catch(function(e){scanStop();show('scanErr',e&&e.name==='NotAllowedError'?T.scanDenied:T.scanFailed);});});
$('scanStop').addEventListener('click',function(){scanStop();$('scanGo').focus();});
document.addEventListener('visibilitychange',function(){if(document.visibilityState!=='visible'&&SC.on)scanStop();});
window.addEventListener('pagehide',function(){if(SC.on)scanStop();});
if(scanOk&&window.BarcodeDetector.getSupportedFormats)window.BarcodeDetector.getSupportedFormats()
 .then(function(f){if(f.indexOf('qr_code')<0){scanOk=false;scanAvail();}}).catch(function(){});
scanAvail();`;
