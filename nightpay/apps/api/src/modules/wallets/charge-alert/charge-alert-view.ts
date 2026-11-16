import { BRAND_NAME } from '../../../common/brand';
import { CLUB_BASE_CSS, clientMoney, escapeHtml } from '../../payments/club-ui';
import { CHROME_CSS, LANG_JS, topBar } from '../../payments/customer-chrome';
import type { PayLanguage } from '../../payments/customer-lang';
import { LOST_CSS } from '../wallet-lost-view';
import { CHARGE_ALERT_TEXT, fillText, type ChargeAlertText } from './charge-alert-text';
import type { NotMeCharge, NotMeResult, NotMeView } from './charge-dispute.service';

/**
 * «Aviso en cada cobro» en las páginas del cliente:
 *  - en la página del saldo (/w/:token): la fila «Avisarme de cada cobro» en
 *    «Más», la hoja de cómo hacerlo en iPhone y su JS (lo usa wallet-page.ts:
 *    define $, C, S, busy, post, toast, openSheet…);
 *  - el service worker (/w/aviso-sw.js) que enseña el aviso con la página
 *    cerrada y abre «No he sido yo»;
 *  - el manifiesto (para añadir el saldo a la pantalla de inicio: en iPhone,
 *    los avisos solo llegan así);
 *  - la página «No he sido yo» (/w/no/<token>).
 * El JS va dentro de plantillas de TypeScript: sin barras invertidas.
 */

export const SERVICE_WORKER_PATH = '/w/aviso-sw.js';
export const SERVICE_WORKER_SCOPE = '/w/';

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** Lo que la página del saldo pasa a su JS (null: apagado). */
export interface AvisoConfig {
  key: string;
  sw: string;
  t: Pick<ChargeAlertText, 'rowOff' | 'rowOn' | 'rowIos' | 'on' | 'off' | 'denied' | 'unsupported' | 'failed'>;
}

export function avisoConfig(lang: PayLanguage, publicKey: string | null | undefined): AvisoConfig | null {
  if (!publicKey) return null;
  const t = CHARGE_ALERT_TEXT[lang];
  return {
    key: publicKey,
    sw: SERVICE_WORKER_PATH,
    t: { rowOff: t.rowOff, rowOn: t.rowOn, rowIos: t.rowIos, on: t.on, off: t.off, denied: t.denied, unsupported: t.unsupported, failed: t.failed },
  };
}

export const AVISO_CSS = `
#avisoHint{font-size:.875rem}
#avisoSheet ol{margin:0;padding-left:1.25rem;display:grid;gap:.5rem;color:var(--fg);text-align:left}
#avisoSheet h2{text-align:left}
`;

/** La fila de «Más» (la enseña el JS si el navegador puede o es un iPhone que aún no la tiene en inicio). */
export function avisoRow(lang: PayLanguage): string {
  const t = CHARGE_ALERT_TEXT[lang];
  return `<button class="row" type="button" id="avisoOpen" hidden>${escapeHtml(t.row)}<small id="avisoHint">${escapeHtml(t.rowOff)}</small></button>\n`;
}

/** iPhone fuera de la pantalla de inicio: los pasos para poder activarlo. */
export function avisoSheet(lang: PayLanguage): string {
  const t = CHARGE_ALERT_TEXT[lang];
  const h = escapeHtml;
  return `<dialog class="sheet" id="avisoSheet" aria-labelledby="avisoTitle">
<h2 id="avisoTitle">${h(t.iosTitle)}</h2>
<ol>${t.iosSteps.map((s) => `<li>${h(s)}</li>`).join('')}</ol>
<p>${h(t.iosNote)}</p>
<button class="btn alt" type="button" data-close>${h(t.iosClose)}</button>
</dialog>
`;
}

/** Para «Añadir a pantalla de inicio»: abre el saldo como app (en iPhone, sin esto no hay avisos). */
export function manifestLink(base: string): string {
  return `<link rel="manifest" href="${escapeHtml(base)}/manifest.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${escapeHtml(BRAND_NAME)}">`;
}

export function walletManifest(base: string, lang: PayLanguage): string {
  return JSON.stringify({
    name: `${BRAND_NAME} · ${lang === 'es' ? 'Mi saldo' : lang === 'fr' ? 'Mon solde' : lang === 'pt' ? 'O meu saldo' : 'My balance'}`,
    short_name: BRAND_NAME,
    start_url: base,
    scope: SERVICE_WORKER_SCOPE,
    display: 'standalone',
    background_color: '#0b0d0e',
    theme_color: '#0b0d0e',
    lang,
  });
}

/**
 * avisoRender(s): la fila sale con el aviso encendido en el servidor, en un
 * saldo vivo (o gastado) y si este navegador puede (o es un iPhone fuera de
 * la pantalla de inicio: entonces enseña los pasos). Encendido en este
 * navegador para ESTE saldo: su suscripción y la marca local del saldo (dos
 * saldos en el mismo móvil no se encienden solos). Apagar quita este saldo en
 * el servidor; el navegador sigue apuntado para los demás.
 */
export const AVISO_JS = `
var AV=C.aviso,avOn=false,avMark='np-aviso:'+C.base;
function avIos(){var u=navigator.userAgent||'';return /iPhone|iPad|iPod/.test(u)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);}
function avHome(){return navigator.standalone===true||(!!window.matchMedia&&matchMedia('(display-mode: standalone)').matches);}
function avCan(){return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;}
function avStore(on){try{if(on)localStorage.setItem(avMark,'1');else localStorage.removeItem(avMark);}catch(e){}}
function avStored(){try{return localStorage.getItem(avMark)==='1';}catch(e){return false;}}
function avHint(){if(!AV)return;$('avisoHint').textContent=!avCan()&&avIos()&&!avHome()?AV.t.rowIos:avOn?AV.t.rowOn:AV.t.rowOff;}
function avisoRender(s){var ok=!!AV&&(s.status==='ACTIVE'||s.status==='DEPLETED')&&!s.merged&&(avCan()||(avIos()&&!avHome()));
 $('avisoOpen').hidden=!ok;if(ok)avHint();}
function avReg(){return navigator.serviceWorker.register(AV.sw,{scope:'/w/'});}
function avKey(){var b=AV.key.replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';
 var r=atob(b),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
function avAsk(){return new Promise(function(ok){var p=Notification.requestPermission(ok);if(p&&p.then)p.then(ok);});}
function avStart(){return avAsk().then(function(p){if(p!=='granted'){var e=new Error('denied');e.avText=AV.t.denied;throw e;}return avReg();})
 .then(function(){return navigator.serviceWorker.ready;})
 .then(function(r){return r.pushManager.getSubscription().then(function(s){return s||r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:avKey()});});})
 .then(function(s){return post('/aviso',s.toJSON());}).then(function(){avOn=true;avStore(true);return AV.t.on;});}
function avStop(){return avReg().then(function(r){return r.pushManager.getSubscription();})
 .then(function(s){return s?post('/aviso/off',{endpoint:s.toJSON().endpoint}):null;})
 .then(function(){avOn=false;avStore(false);return AV.t.off;});}
if(AV&&avCan()&&avStored()){avReg().then(function(r){return r.pushManager.getSubscription();}).then(function(s){
 avOn=!!s&&Notification.permission==='granted';if(avOn)post('/aviso',s.toJSON()).catch(function(){});else avStore(false);avHint();}).catch(function(){});}
$('avisoOpen').addEventListener('click',function(){var b=$('avisoOpen');if(busy||!AV)return;
 if(!avCan()){if(avIos()&&!avHome())openSheet($('avisoSheet'));else toast(AV.t.unsupported);return;}
 busy=true;b.disabled=true;
 (avOn?avStop():avStart()).then(function(text){toast(text);})
  .catch(function(e){toast(e&&e.avText?e.avText:e&&e.code?msg(e):AV.t.failed);})
  .then(function(){busy=false;b.disabled=false;avHint();});});`;

/**
 * El service worker: enseña el aviso (también con la página cerrada) y, al
 * tocarlo, abre la página del saldo o «No he sido yo». Donde el aviso no
 * lleva botones (iPhone), tocarlo abre «No he sido yo», que enseña el cobro
 * y no hace nada sin confirmar. Solo abre páginas de /w/ de este dominio.
 */
export const SERVICE_WORKER_JS = `'use strict';
self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('push',function(e){var d={};
 try{d=e.data?e.data.json():{};}catch(x){d={};}
 var acts=d.notMeUrl&&self.Notification&&Notification.maxActions>0?[{action:'no',title:String(d.notMeLabel||'')}]:[];
 e.waitUntil(self.registration.showNotification(String(d.title||'${escapeJs(BRAND_NAME)}'),{
  body:String(d.body||''),tag:d.tag?String(d.tag):undefined,renotify:Boolean(d.tag),
  data:{url:d.url,notMeUrl:d.notMeUrl,acts:acts.length>0},actions:acts}));});
self.addEventListener('notificationclick',function(e){var n=e.notification,d=n.data||{};n.close();
 var to=e.action==='no'||!d.acts?d.notMeUrl||d.url:d.url;
 if(typeof to!=='string'||to.indexOf('/w/')!==0)return;
 e.waitUntil(self.clients.openWindow(to));});
`;

function escapeJs(s: string): string {
  return s.replace(/['<>&]/g, '');
}

// ─── «No he sido yo» (/w/no/<token>) ────────────────────────────────────

const NOT_ME_CSS = `
main{max-width:28rem;min-height:calc(100svh - 3.5rem);margin:auto;padding:1rem 1rem 2rem;display:flex;flex-direction:column;justify-content:center;gap:1.25rem}
.box{padding:1.5rem 1.25rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);display:grid;gap:.75rem}
.box h1{font-size:1.375rem}
.kick{margin:0}
.amt{margin:0;font:600 3rem/1 var(--num);letter-spacing:-.02em;color:var(--fg)}
.where{margin:0;color:var(--fg);font-size:1.0625rem}
.txt{color:var(--fg);line-height:1.5}
.foot{line-height:1.5;color:var(--dim);font-size:.875rem}
form{display:grid}
`;

function when(at: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at);
}

function chargeBox(t: ChargeAlertText, c: NotMeCharge, title: string): string {
  const h = escapeHtml;
  const money = clientMoney(c.totalCents, t.locale);
  const meta = c.ref ? fillText(t.when, { ref: c.ref, when: when(c.at, t.locale) }) : when(c.at, t.locale);
  return `<section class="box"><p class="kick">${h(meta)}</p><h1>${h(title)}</h1>`
    + `<p class="amt num">${h(money)}</p>`
    + (c.venueName ? `<p class="where">${h(fillText(t.atVenue, { venue: c.venueName }))}</p>` : '')
    + `</section>`;
}

function messageBox(title: string, text: string): string {
  return `<section class="box"><span class="lockc">${LOCK_ICON}</span><h1>${escapeHtml(title)}</h1><p class="txt">${escapeHtml(text)}</p></section>`;
}

function page(lang: PayLanguage, base: string, title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${escapeHtml(title)}</title><style>${CLUB_BASE_CSS}${CHROME_CSS}${LOST_CSS}${NOT_ME_CSS}</style></head><body>${topBar(lang, (l) => `${base}?lang=${l}`)}<main>${body}</main><script>${script}${LANG_JS}</script></body></html>`;
}

/** La página: el cobro y «No he sido yo» (formulario: funciona sin JS); o por qué el enlace no sirve. */
export function renderNotMePage(base: string, lang: PayLanguage, view: NotMeView | NotMeResult): string {
  const t = CHARGE_ALERT_TEXT[lang];
  const h = escapeHtml;
  switch (view.state) {
    case 'invalid':
      return page(lang, base, t.invalidTitle, messageBox(t.invalidTitle, t.invalidText));
    case 'expired':
      return page(lang, base, t.expiredTitle, messageBox(t.expiredTitle, t.expiredText));
    case 'not-paid':
      return page(lang, base, t.invalidTitle, messageBox(t.invalidTitle, t.notPaidText));
    case 'already':
      return page(lang, base, t.alreadyTitle, `${chargeBox(t, view, t.alreadyTitle)}<p class="txt">${h(t.alreadyText)}</p>`);
    case 'done': {
      const ref = view.ref ?? '';
      const text = fillText(view.blockedCards > 0 ? t.doneText : t.doneNoCard, { ref }).replace(/\s+\./, '.');
      return page(lang, base, t.doneTitle, `${messageBox(t.doneTitle, text)}<p class="safe">${h(t.keep)}</p>`);
    }
    case 'ask': {
      const form = `<form method="post" action="${h(base)}?lang=${lang}" enctype="text/plain" id="notMeForm">`
        + `<button class="btn red" type="submit" id="notMeGo">${LOCK_ICON}<span>${h(t.go)}</span></button></form>`;
      // Un toque: el botón queda ocupado (no se manda dos veces).
      const script = `(function(){var f=document.getElementById('notMeForm'),b=document.getElementById('notMeGo');
f.addEventListener('submit',function(){b.disabled=true;b.classList.add('busy');b.lastChild.textContent=${JSON.stringify(t.goBusy)};});})();`;
      return page(
        lang,
        base,
        t.pageTitle,
        `${chargeBox(t, view, t.question)}<p class="txt">${h(t.explain)}</p><p class="safe">${h(t.keep)}</p>${form}<p class="foot">${h(t.ifYou)}</p>`,
        script,
      );
    }
  }
}
