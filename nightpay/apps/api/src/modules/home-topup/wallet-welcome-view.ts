import { clientMoney, escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/customer-lang';
import { PAY_TEXT } from '../payments/pay-i18n';
import type { TopUpProof } from '../wallets/wallet-topup.service';
import { HOME_TOPUP_TEXT } from './home-topup-text';

/**
 * Lo que «Cargar saldo antes de llegar» pinta en la página del saldo (/w),
 * aparte para no mezclarlo con lo de siempre (wallet-page.ts lo llama):
 *  - la bienvenida del saldo nuevo cargado desde casa (?nuevo=<cobro>):
 *    debajo del «Pagado», qué hacer al llegar, «Guardar comprobante» y
 *    «Guardar el enlace»;
 *  - el QR de la ficha en «Tu código» (saldo activo sin ficha y el local da
 *    fichas): recepción lo escanea y le da una ficha unida a su saldo.
 * Sin barras invertidas en el JS (va dentro de una plantilla).
 */

export const WELCOME_CSS = `
.wel{gap:.625rem}
.wel .done{text-align:center}
.fqr{display:flex;flex-direction:column;align-items:center;gap:.5rem;margin-top:.35rem;padding-top:.875rem;border-top:1px solid var(--line);text-align:center}
.fqr .fqrt{color:var(--fg);font-weight:600}
.fqri{width:min(15rem,72vw);padding:.4rem;border-radius:var(--r);background:var(--cream)}
.fqri svg{display:block;width:100%;height:auto}
.rcpv{position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;gap:1rem;overflow:auto;padding:calc(1rem + env(safe-area-inset-top)) 1rem calc(1rem + env(safe-area-inset-bottom));background:var(--scrim);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.rcpv>:first-child{margin-top:auto}
.rcpv>:last-child{margin-bottom:auto}
.rcpv img{display:block;max-width:100%;max-height:68vh;border-radius:var(--r);box-shadow:var(--sh-dialog)}
.rcpv p{max-width:22rem;color:var(--fg);font-weight:500;text-align:center}
.rcpv .btn{flex:none;max-width:20rem}
`;

/** Bajar a mi móvil (decorativo). */
const SAVE_IC =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';

/**
 * Lo que dibuja el comprobante (lo pinta el JS en el móvil, con lo que ya
 * sabe la página): el local, lo cargado con céntimos, cuándo, el código de
 * confirmación del pago, el código del saldo y, si está en la página, el QR
 * de la ficha, con «no lo compartas» (ficha-qr.ts). Nada que no se vea ya
 * en la pantalla.
 */
function receiptData(lang: PayLanguage, venueName: string | null, proof: TopUpProof, walletCode: string): Record<string, string> {
  const t = HOME_TOPUP_TEXT[lang];
  const p = PAY_TEXT[lang];
  const at = proof.authorizedAt ? new Date(proof.authorizedAt) : null;
  return {
    venue: venueName ?? '',
    kick: t.receiptKick,
    amount: clientMoney(proof.amountCents, p.locale, 'EUR', true),
    when:
      at && !Number.isNaN(at.getTime())
        ? at.toLocaleString(p.locale, { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '',
    confirm: `${p.codeLabel} ${proof.code}`,
    saldoLabel: t.receiptSaldo,
    saldo: walletCode,
    show: t.receiptShow,
    showNoQr: t.receiptShowNoQr,
    private: t.receiptPrivate,
    noExpiry: t.noExpiry,
    file: `${t.receiptFile}-${walletCode.replace(/[^A-Za-z0-9-]/g, '')}.png`,
    fail: t.receiptFail,
  };
}

/**
 * «Tu saldo está listo»: debajo del «Pagado» de la carga que lo creó. Qué
 * hacer al llegar: el móvil y, si la página lleva el QR de la ficha (el
 * local da fichas), la ficha en recepción; sin él, solo el móvil (sin el
 * dato, como antes: con la ficha).
 */
export function welcomeCard(
  lang: PayLanguage,
  venueName: string | null,
  proof: TopUpProof,
  walletCode: string,
  withFichaQr = true,
): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  const title = venueName ? t.welcomeTitle.split('{venue}').join(venueName) : t.welcomeTitleNoVenue;
  return `<section class="card main wel" id="welcome" aria-labelledby="welTitle">
<p class="kick">${h(t.welcomeKick)}</p>
<h2 id="welTitle">${h(title)}</h2>
<p>${h(withFichaQr ? t.welcomeBody : t.stepArriveNoFicha)}</p>
<button class="btn" type="button" id="welReceipt" data-r="${h(JSON.stringify(receiptData(lang, venueName, proof, walletCode)))}">${SAVE_IC}<span>${h(t.receiptSave)}</span></button>
<p class="small">${h(t.receiptHint)}</p>
<p class="small done" id="welSaved" role="status" hidden>${h(t.receiptSaved)}</p>
<p class="err" id="welReceiptErr" role="alert" hidden></p>
<button class="btn alt" type="button" id="welShare">${h(t.shareLink)}</button>
<p class="small">${h(t.saveLink)}</p>
<p class="small done" id="welCopied" role="status" hidden>${h(t.copied)}</p>
<div class="rcpv" id="rcpView" role="dialog" aria-modal="true" aria-labelledby="rcpHold" hidden>
<img id="rcpImg" alt="">
<p id="rcpHold">${h(t.receiptHold)}</p>
<button class="btn alt" type="button" id="rcpClose">${h(t.receiptClose)}</button>
</div>
</section>
`;
}

/** El QR de la ficha (el SVG lo hace el servidor: ficha-qr.ts). */
export function fichaQrBlock(lang: PayLanguage, svg: string): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  return `<div class="fqr" id="fichaQr">
<p class="fqrt">${h(t.fichaQrTitle)}</p>
<div class="fqri" role="img" aria-label="${h(t.fichaQrTitle)}">${svg}</div>
<p class="small">${h(t.fichaQrHint)}</p>
</div>`;
}

/**
 * El comprobante, en el propio móvil (sin pedir nada al servidor): un PNG de
 * 1080 px de ancho dibujado en un canvas con las letras de la página
 * (Instrument Sans y Manrope; si no llegan, la del sistema) y los colores de
 * Grafito: sin lima ni mayúsculas, solo la placa crema del QR. El QR se traza con su propio dibujo (Path2D del
 * SVG de ficha-qr.ts: sin imágenes que «manchen» el canvas). Solo va en la
 * página con la bienvenida (wallet-page.ts). Lo puro (rcpWrap, rcpHeight,
 * rcpKind) se prueba aparte.
 *
 * rcpKind: a dónde va la imagen. Los navegadores de dentro de las apps
 * (Instagram, Facebook, TikTok, LinkedIn… y los WebView de Android) no
 * descargan: ahí se comparte si se puede o se enseña en grande para
 * mantenerla pulsada; el iPhone, compartir («Guardar imagen» → Fotos); el
 * resto (Chrome en Android, ordenador), descarga.
 */
export const RECEIPT_JS = `
function rcpWrap(x,text,maxW){var out=[],line='';String(text).split(' ').forEach(function(w){var t=line?line+' '+w:w;
 if(line&&x.measureText(t).width>maxW){out.push(line);line=w;}else line=t;});if(line)out.push(line);return out;}
function rcpHeight(qr,showLines,noteLines){return (qr?1316:620)+92+92+84+(showLines-1)*52+14+noteLines*44+64+56;}
function rcpKind(ua,ipadOs){if(/Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|LinkedInApp|TikTok|musical_ly|BytedanceWebview|Snapchat/.test(ua)||ua.indexOf(' Line/')>=0||ua.indexOf('; wv)')>=0)return 'inapp';
 return /iPhone|iPad|iPod/.test(ua)||ipadOs?'ios':'download';}
function rcpRound(x,X,Y,w,h,r){x.beginPath();x.moveTo(X+r,Y);x.arcTo(X+w,Y,X+w,Y+h,r);x.arcTo(X+w,Y+h,X,Y+h,r);x.arcTo(X,Y+h,X,Y,r);x.arcTo(X,Y,X+w,Y,r);x.closePath();}
function rcpFit(x,text,weight,size,family,maxW){var s=size;x.font=weight+' '+s+'px '+family;
 while(s>24&&x.measureText(text).width>maxW){s-=4;x.font=weight+' '+s+'px '+family;}}
function rcpQr(){var box=document.getElementById('fichaQr'),s=box&&!box.hidden?box.querySelector('svg'):null;
 if(!s||typeof Path2D==='undefined')return null;var p=s.querySelector('path[stroke]'),vb=s.viewBox&&s.viewBox.baseVal;
 return p&&vb&&vb.width?{d:p.getAttribute('d'),n:vb.width}:null;}
function rcpDraw(d,logo,qr){var W=1080,P=72,QS=600,SYS='OxioSans,system-ui,-apple-system,Segoe UI,Roboto,sans-serif',NUM='OxioManrope,'+SYS,maxW=W-2*P-96;
 var m=document.createElement('canvas').getContext('2d');m.font='600 38px '+SYS;var show=rcpWrap(m,qr?d.show:d.showNoQr,maxW);
 m.font='500 31px '+SYS;var priv=qr?rcpWrap(m,d.private,maxW):[];m.font='400 31px '+SYS;var keep=rcpWrap(m,d.noExpiry,maxW);
 var H=rcpHeight(!!qr,show.length,priv.length+keep.length),c=document.createElement('canvas');c.width=W;c.height=H;var x=c.getContext('2d'),y;
 x.fillStyle='#091518';x.fillRect(0,0,W,H);
 if(logo&&logo.complete&&logo.naturalWidth)x.drawImage(logo,P,96,Math.round(62*logo.naturalWidth/logo.naturalHeight),62);
 x.textAlign='right';x.fillStyle='#bab6ad';x.font='400 31px '+SYS;x.fillText(d.when,W-P,134);
 rcpRound(x,P/2,200,W-P,H-256,36);x.fillStyle='#19272b';x.fill();x.lineWidth=2;x.strokeStyle='#314045';x.stroke();
 x.textAlign='center';x.fillStyle='#cfcbc2';x.font='500 32px '+SYS;x.fillText(d.kick,W/2,292);
 x.fillStyle='#efe9df';rcpFit(x,d.venue,'600',46,SYS,maxW);x.fillText(d.venue,W/2,356);
 x.fillStyle='#efe9df';rcpFit(x,d.amount,'600',140,NUM,maxW);x.fillText(d.amount,W/2,500);
 x.fillStyle='#cfcbc2';x.font='400 33px '+SYS;x.fillText(d.confirm,W/2,566);
 x.setLineDash([16,12]);x.strokeStyle='#314045';x.lineWidth=2;x.beginPath();x.moveTo(P+48,620);x.lineTo(W-P-48,620);x.stroke();x.setLineDash([]);
 y=620;if(qr){var qx=(W-QS)/2;rcpRound(x,qx-24,668,QS+48,QS+48,36);x.fillStyle='#efe9df';x.fill();
  x.save();x.translate(qx,692);x.scale(QS/qr.n,QS/qr.n);x.strokeStyle='#1f2c36';x.lineWidth=1;x.stroke(new Path2D(qr.d));x.restore();y=1316;}
 y+=92;x.fillStyle='#bab6ad';x.font='500 32px '+SYS;x.fillText(d.saldoLabel,W/2,y);
 y+=92;x.fillStyle='#efe9df';rcpFit(x,d.saldo,'700',84,NUM,maxW);x.fillText(d.saldo,W/2,y);
 y+=84;x.font='600 38px '+SYS;show.forEach(function(l,i){x.fillText(l,W/2,y+i*52);});y+=(show.length-1)*52+14;
 x.fillStyle='#f5b342';x.font='500 31px '+SYS;priv.forEach(function(l){y+=44;x.fillText(l,W/2,y);});
 x.fillStyle='#bab6ad';x.font='400 31px '+SYS;keep.forEach(function(l){y+=44;x.fillText(l,W/2,y);});
 return c;}
function rcpFonts(){var f=document.fonts;if(!f||!f.load)return Promise.resolve();
 return Promise.race([Promise.all([f.load('600 80px OxioManrope').catch(function(){}),f.load('500 32px OxioSans').catch(function(){})]),new Promise(function(r){setTimeout(r,1500);})]);}
function rcpPng(c){return new Promise(function(ok,ko){c.toBlob(function(b){if(b)ok(b);else ko(new Error('png'));},'image/png');});}
function rcpFile(b,name){try{return new File([b],name,{type:'image/png'});}catch(e){return null;}}
function rcpDownload(b,name){var u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();
 setTimeout(function(){URL.revokeObjectURL(u);},60000);}
`;

/**
 * welcomeRender(s): con la ficha ya dada, el saldo cerrado o «Me voy» pedido
 * (recepción ya no daría ficha), el QR se quita.
 * «Guardar comprobante» (con RECEIPT_JS): la imagen se prepara al abrir la
 * página, para que en el iPhone compartir vaya dentro del mismo toque (Safari
 * no deja compartir después de esperar); si no estaba lista o el QR cambió,
 * se hace al pulsar. La imagen en grande es un diálogo: Escape o «Cerrar», y
 * el foco no se sale de él. «Guardar el enlace»: el menú de compartir del
 * móvil o, sin él, copiarlo.
 */
export const WELCOME_JS = `
function welcomeRender(s){var q=$('fichaQr');if(q)q.hidden=!!s.hasCard||s.status!=='ACTIVE'||!!s.closeRequested;}
var welShare=$('welShare');if(welShare)welShare.addEventListener('click',function(){var u=location.origin+C.base;
 if(navigator.share){navigator.share({url:u,title:document.title}).catch(function(){});return;}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(u).then(function(){$('welCopied').hidden=false;}).catch(function(){});});
var welReceipt=$('welReceipt');
if(welReceipt&&typeof rcpDraw==='function'){
 var rcpLast=null,rcpBlob=null,rcpWithQr=null,rcpD={};try{rcpD=JSON.parse(welReceipt.getAttribute('data-r')||'{}');}catch(e){}
 var rcpWhere=rcpKind(navigator.userAgent,navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 var rcpMake=function(){var qr=rcpQr();return rcpFonts().then(function(){rcpLast=rcpDraw(rcpD,document.querySelector('img.wm'),qr);rcpWithQr=!!qr;return rcpPng(rcpLast);})
  .then(function(b){rcpBlob=b;return b;});};
 var rcpShow=function(){if(!rcpLast)return;var im=$('rcpImg');im.src=rcpLast.toDataURL('image/png');
  im.alt=[rcpD.kick,rcpD.venue,rcpD.amount,rcpD.saldo].filter(Boolean).join(' · ');$('rcpView').hidden=false;$('rcpClose').focus();};
 var rcpHide=function(){$('rcpView').hidden=true;welReceipt.focus();};
 var rcpShare=function(f){return navigator.share({files:[f]}).then(function(){$('welSaved').hidden=false;},function(e){if(!e||e.name!=='AbortError')rcpShow();});};
 var rcpCanShare=function(f){return !!(f&&rcpWhere!=='download'&&navigator.canShare&&navigator.canShare({files:[f]}));};
 var rcpBusy=function(on){welReceipt.classList.toggle('busy',on);if(on)welReceipt.setAttribute('aria-busy','true');else welReceipt.removeAttribute('aria-busy');};
 welReceipt.addEventListener('click',function(){if(welReceipt.classList.contains('busy'))return;$('welSaved').hidden=true;show('welReceiptErr','');
  var ready=rcpBlob&&rcpWithQr===!!rcpQr(),f=ready?rcpFile(rcpBlob,rcpD.file):null;
  if(rcpCanShare(f)){rcpShare(f);return;}
  rcpBusy(true);
  (ready?Promise.resolve(rcpBlob):rcpMake()).then(function(b){var f2=rcpFile(b,rcpD.file);
   if(rcpWhere==='download'){rcpDownload(b,rcpD.file);$('welSaved').hidden=false;return;}
   if(rcpCanShare(f2))return rcpShare(f2);
   rcpShow();},function(){show('welReceiptErr',rcpD.fail);}).then(function(){rcpBusy(false);});});
 $('rcpClose').addEventListener('click',rcpHide);
 $('rcpView').addEventListener('click',function(e){if(e.target===$('rcpView'))rcpHide();});
 document.addEventListener('keydown',function(e){if($('rcpView').hidden)return;
  if(e.key==='Escape')rcpHide();else if(e.key==='Tab'){e.preventDefault();$('rcpClose').focus();}});
 setTimeout(function(){rcpMake().catch(function(){});},300);}`;
