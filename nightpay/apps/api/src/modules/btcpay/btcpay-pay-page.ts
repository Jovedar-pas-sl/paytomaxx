import type { BtcpayInvoiceView } from '@nightpay/contracts';
import { clientMoney, escapeHtml } from '../payments/club-ui';
import { customerPage } from '../payments/customer-page';
import type { LangHref } from '../payments/customer-chrome';
import { LOCK_ICON } from '../payments/pay-choose-page';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';

/**
 * «Pagar con bitcoin» (/pay/:token/bitcoin): el QR grande (dibujado en el
 * servidor), el importe en euros y en BTC, «Abrir en mi cartera» (enlace
 * bitcoin:), «Copiar dirección», la página de pago completa y el tiempo que
 * queda. Se pone al día sola (/pay/:token/bitcoin/status) y, al pagarse o
 * cerrarse la factura, vuelve a /pay/:token (el «Pagado» o la elección).
 *
 * Reglas de las páginas del cliente: el JS va en plantillas de TypeScript SIN
 * barras invertidas (ES5, sin regex ni «\n»), la CSP deja scripts en la propia
 * página y fotos data:, y nada de lo que llega de BTCPay se pinta sin escapar:
 * el enlace del QR solo si empieza por bitcoin: o lightning: y el de la página
 * de pago solo si es https.
 */

export interface BitcoinPageInput {
  token: string;
  lang: PayLanguage;
  view: BtcpayInvoiceView;
  venueName: string | null;
  concept: string | null;
  langHref: LangHref;
  /** El cobro se canceló o la factura se cerró: sin QR, «Elegir otra forma de pagar». */
  closed?: 'expired' | 'problem' | null;
}

const BTC_CSS = `
.btc{width:100%;max-width:26rem;margin:0 auto;min-height:calc(100vh - 3.5rem);min-height:calc(100svh - 3.5rem);padding:.5rem 1rem 2rem;display:flex;flex-direction:column;align-items:center;gap:.9rem;text-align:center}
.btc h1{font-size:1.25rem;font-weight:600;margin:.25rem 0 0}
.btc-venue{margin:0;color:var(--label);font-size:.9375rem}
.btc-eur{font-family:var(--num);font-size:clamp(2.5rem,12vw,3rem);font-weight:600;letter-spacing:-.02em;line-height:1.05;color:var(--fg);margin:0}
.btc-btc{margin:0;color:var(--label);font-size:.9375rem;font-variant-numeric:tabular-nums}
.btc-live{width:100%;display:flex;flex-direction:column;align-items:center;gap:.9rem}
.btc-qr{background:#fff;border-radius:var(--r);padding:.75rem;width:min(100%,19rem);line-height:0;box-shadow:var(--sh-dialog)}
.btc-qr img{display:block;width:100%;height:auto;image-rendering:pixelated}
.btc-scan{margin:0;font-size:.9375rem;color:var(--label)}
.btc-actions{width:100%;display:flex;flex-direction:column;gap:.5rem}
.btc-addr{width:100%;padding:.6rem .75rem;border-radius:var(--r-field);border:1px solid var(--line);background:var(--surface);color:var(--label);font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;text-align:center;text-overflow:ellipsis}
.btc-time{margin:0;color:var(--label);font-size:.9375rem}
.btc-time b{font-family:var(--num);font-variant-numeric:tabular-nums;color:var(--fg);font-size:1.125rem}
.btc-state{margin:0;min-height:1.5rem;color:var(--fg);font-weight:500}
.btc-offline{margin:0;padding:.6rem .8rem;border-radius:var(--r-tile);color:var(--fg);background:rgb(245 179 66/.1);border:1px solid var(--warn);width:100%}
.btc-full{color:var(--label);font-size:.875rem}
.btc-msg{display:flex;flex-direction:column;gap:.5rem;padding:1rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);width:100%}
.btc-msg h2{margin:0;font-size:1.25rem}
.btc-msg p{margin:0;color:var(--label)}
.btc-other{width:100%;margin:0}
.btc [hidden]{display:none!important}
`;

const BTC_JS = `
var C=JSON.parse(document.getElementById('btcCfg').textContent),clock=document.getElementById('btcClock'),stateEl=document.getElementById('btcState'),
 off=document.getElementById('btcOffline'),other=document.getElementById('btcOther'),end=Date.parse(C.expiresAt),done=false,busy=false;
function pad(n){return n<10?'0'+n:''+n;}
function tick(){var s=Math.max(0,Math.floor((end-Date.now())/1000));clock.textContent=Math.floor(s/60)+':'+pad(s%60);if(s===0)poll();}
function go(){done=true;location.replace(C.payHref);}
function offline(on){if(off)off.hidden=!on;}
function problem(){done=true;document.getElementById('btcLive').hidden=true;document.getElementById('btcProblem').hidden=false;}
function apply(d){if(d.state==='paid'||d.state==='closed'||d.state==='gone'){go();return;}
 if(d.state==='incident'){problem();return;}
 stateEl.textContent=d.status==='Processing'?C.t.confirming:C.t.waiting;
 if(other)other.hidden=d.status==='Processing';}
if(other)other.addEventListener('submit',function(e){if(done){e.preventDefault();return;}done=true;
 var b=other.querySelector('button');if(b){b.setAttribute('aria-disabled','true');b.classList.add('busy');}});
function poll(){if(busy||done)return;busy=true;var x=new XMLHttpRequest();x.open('GET',C.statusUrl,true);x.timeout=8000;x.setRequestHeader('Accept','application/json');
 x.onload=function(){busy=false;offline(false);if(x.status!==200)return;var d;try{d=JSON.parse(x.responseText);}catch(e){return;}apply(d);};
 x.onerror=function(){busy=false;offline(true);};x.ontimeout=function(){busy=false;offline(true);};x.send();}
var cp=document.getElementById('btcCopy');
function fallback(ok){var i=document.getElementById('btcAddr');i.select();try{if(document.execCommand('copy'))ok();}catch(e){}}
if(cp)cp.addEventListener('click',function(){function ok(){cp.textContent=C.t.copied;setTimeout(function(){cp.textContent=C.t.copyAddress;},2000);}
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(C.copy).then(ok,function(){fallback(ok);});}else fallback(ok);});
tick();setInterval(tick,1000);setInterval(poll,3000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)poll();});
window.addEventListener('online',poll);
window.addEventListener('pageshow',function(e){if(e.persisted)location.reload();});
`;

/** El JSON del <script type=application/json>: «<» como su escape JSON (no puede cerrar la etiqueta). */
const ESCAPED_LT = `${String.fromCharCode(92)}u003c`;
const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, ESCAPED_LT);

/** El enlace del QR solo si es de bitcoin o Lightning; la página de pago solo si es https. */
export function safeQrLink(link: string): string | null {
  return /^(bitcoin|lightning):[^\s"'<>]+$/i.test(link) ? link : null;
}
export function safeHttpsLink(link: string): string | null {
  return /^https:\/\/[^\s"'<>]+$/i.test(link) ? link : null;
}

export function renderBitcoinPage(i: BitcoinPageInput): string {
  const t = PAY_TEXT[i.lang];
  const b = t.bitcoin;
  const v = i.view;
  const payHref = `/pay/${encodeURIComponent(i.token)}?lang=${i.lang}`;
  const eur = clientMoney(v.amountCents, t.locale, 'EUR', true);
  const qrLink = safeQrLink(v.qrLink);
  const full = safeHttpsLink(v.checkoutLink);
  const btcLine = v.amountBtc
    ? `<p class="btc-btc">${escapeHtml(b.inBtc)}: <b>${escapeHtml(v.amountBtc)} BTC</b>${v.rate ? ` · ${escapeHtml(b.rate(clientMoney(Math.round(Number(v.rate) * 100) || 0, t.locale, 'EUR', false)))}` : ''}</p>`
    : '';
  const head = `<noscript><meta http-equiv="refresh" content="10"></noscript><style>${BTC_CSS}</style>`;

  if (i.closed || !qrLink) {
    const problem = i.closed === 'problem';
    const body = `<main class="btc">
${i.venueName ? `<p class="btc-venue">${escapeHtml(i.venueName)}</p>` : ''}
<p class="btc-eur num">${escapeHtml(eur)}</p>
<div class="btc-msg" role="status"><h2>${escapeHtml(problem ? b.problemTitle : b.expiredTitle)}</h2><p>${escapeHtml(problem ? b.problemBody : b.expiredBody)}</p></div>
<div class="btc-actions"><a class="btn alt" href="${escapeHtml(payHref)}">${escapeHtml(b.other)}</a></div>
<p class="foot secure">${LOCK_ICON}${escapeHtml(t.secure)}</p>
</main>`;
    return customerPage(t, b.title, body, { head, layout: 'bare', langHref: i.langHref });
  }

  const copyValue = v.chainAddress ?? qrLink;
  // «Pagar de otra forma»: cierra la factura y vuelve a /pay/:token. Con el pago ya en la red, no se ofrece.
  const otherAction = `/pay/${encodeURIComponent(i.token)}/bitcoin/other?lang=${i.lang}`;
  const otherWay = `<form class="btc-other" id="btcOther" method="post" action="${escapeHtml(otherAction)}"${v.status === 'Processing' ? ' hidden' : ''}><button class="btn alt" type="submit">${escapeHtml(b.payOtherWay)}</button></form>`;
  const config = {
    expiresAt: v.expiresAt,
    statusUrl: `/pay/${encodeURIComponent(i.token)}/bitcoin/status`,
    payHref,
    copy: copyValue,
    t: { waiting: b.waiting, confirming: b.confirming, copied: b.copied, copyAddress: b.copyAddress },
  };
  const body = `<main class="btc">
<h1>${escapeHtml(b.title)}</h1>
${i.venueName ? `<p class="btc-venue">${escapeHtml(i.venueName)}${i.concept ? ` · ${escapeHtml(i.concept)}` : ''}</p>` : i.concept ? `<p class="btc-venue">${escapeHtml(i.concept)}</p>` : ''}
<p class="btc-eur num">${escapeHtml(eur)}</p>
${btcLine}
<div id="btcLive" class="btc-live">
<div class="btc-qr"><img src="${escapeHtml(v.qrImage)}" width="260" height="260" alt="${escapeHtml(b.qrAlt)}"></div>
<p class="btc-scan">${escapeHtml(b.scan)}</p>
<div class="btc-actions">
<a class="btn" id="btcOpen" href="${escapeHtml(qrLink)}">${escapeHtml(b.openWallet)}</a>
<button class="btn alt" id="btcCopy" type="button">${escapeHtml(b.copyAddress)}</button>
<input class="btc-addr" id="btcAddr" type="text" readonly value="${escapeHtml(copyValue)}" aria-label="${escapeHtml(b.copyAddress)}">
</div>
${full ? `<p><a class="btc-full" href="${escapeHtml(full)}" target="_blank" rel="noopener noreferrer">${escapeHtml(b.fullPage)}</a></p>` : ''}
<p class="btc-time">${escapeHtml(b.timeLeft)}: <b id="btcClock" aria-hidden="true">--:--</b></p>
<p class="btc-state" id="btcState" aria-live="polite">${escapeHtml(v.status === 'Processing' ? b.confirming : b.waiting)}</p>
<p class="btc-offline" id="btcOffline" role="status" hidden>${escapeHtml(b.offline)}</p>
${otherWay}
</div>
<div class="btc-msg" id="btcProblem" role="alert" hidden><h2>${escapeHtml(b.problemTitle)}</h2><p>${escapeHtml(b.problemBody)}</p></div>
<p class="foot secure">${LOCK_ICON}${escapeHtml(t.secure)}</p>
</main>
<script type="application/json" id="btcCfg">${jsonForScript(config)}</script>
<script>${BTC_JS}</script>`;
  return customerPage(t, b.title, body, { head, layout: 'bare', langHref: i.langHref });
}
