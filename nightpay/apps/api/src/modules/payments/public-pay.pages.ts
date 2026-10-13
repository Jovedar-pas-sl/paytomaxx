import type { PayDevice } from './pay-device';
import { PAY_TEXT, type PayErrorKey, type PayLanguage, type PayText } from './pay-i18n';
import {
  CLOSED_REASON,
  PAID_STATES,
  confirmationCode,
  type PayClosedReason,
  type PayReceiptView,
  type PayRedirect,
  type PayResultView,
} from './pay-redirect';

/**
 * Páginas del cliente en /pay/... (Fase 1B). Look "Club": negro + lima, letra
 * grande. HTML autocontenido (sin fuentes externas: la CSP del API no las
 * permite y el cliente puede tener mala red). Todo el texto sale de pay-i18n.
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

const BASE_CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:1.5rem 1rem;background:#0b0b0b;color:#f5f5f0;display:grid;place-items:center;min-height:100vh;font-size:18px}
main{max-width:24rem;width:100%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:.75rem}
h1{font-size:2rem;line-height:1.1;margin:0}
p{color:#b4b4ac;line-height:1.5;margin:0}
a{color:#d4ff3a}
.btn{display:block;width:100%;margin-top:1rem;padding:1rem;border-radius:10px;background:#d4ff3a;color:#0b0b0b;font-weight:800;text-decoration:none;font-size:1.05rem;border:none;cursor:pointer}
.amount{font-size:3.4rem;font-weight:800;letter-spacing:-.03em;color:#f5f5f0;line-height:1}
.small{font-size:.9rem}
.footer{margin-top:2rem;font-size:.8rem;color:#8a8a83}
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/** Para meter un valor en un <script>: JSON sin poder cerrar la etiqueta. */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c');
}

function formatAmount(cents: number, currency: string, t: PayText): string {
  return (cents / 100).toLocaleString(t.locale, { style: 'currency', currency });
}

/** "5 €" en vez de "5,00 €" para los botones de propina. */
function formatShort(cents: number, currency: string, t: PayText): string {
  return (cents / 100).toLocaleString(t.locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

function formatTime(d: Date, t: PayText): string {
  return d.toLocaleTimeString(t.locale, { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(d: Date, t: PayText): string {
  return d.toLocaleString(t.locale, {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function payHref(token: string, lang: PayLanguage): string {
  return `/pay/${encodeURIComponent(token)}?lang=${lang}`;
}

export function receiptHref(token: string, lang: PayLanguage): string {
  return `/pay/${encodeURIComponent(token)}/receipt?lang=${lang}`;
}

function page(t: PayText, title: string, body: string, extraHead = ''): string {
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${extraHead}
<style>${BASE_CSS}</style>
</head><body><main>
${body}
<div class="footer">${escapeHtml(t.secure)}</div>
</main></body></html>`;
}

// ─── Página de pago ─────────────────────────────────────────────────────

const CHOOSE_CSS = `<style>
.kick{font-size:.85rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
form{width:100%;display:flex;flex-direction:column;gap:.75rem;margin-top:.5rem}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{color:#b4b4ac;margin:0 auto .5rem;padding:0}
.tipgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(5rem,1fr));gap:.5rem}
.tipgrid label{display:block;position:relative}
.tipgrid input{position:absolute;opacity:0;width:1px;height:1px}
.tipgrid span{display:block;padding:.85rem .25rem;border:2px solid #2a2a2a;border-radius:10px;font-weight:700;color:#f5f5f0;cursor:pointer}
.tipgrid input:checked+span{border-color:#d4ff3a;background:#1b2208;color:#d4ff3a}
.tipgrid input:focus-visible+span{outline:2px solid #d4ff3a;outline-offset:2px}
.total{color:#f5f5f0;font-size:1.1rem}
.pay{width:100%;padding:1.05rem;border-radius:10px;font-weight:800;font-size:1.1rem;cursor:pointer;border:2px solid #d4ff3a;background:#d4ff3a;color:#0b0b0b}
.pay.alt{background:transparent;color:#f5f5f0;border-color:#3a3a3a}
.pay:focus-visible{outline:2px solid #f5f5f0;outline-offset:3px}
form.sending .pay{opacity:.55}
.warn{border:2px solid #ffb020;border-radius:10px;padding:.75rem 1rem;color:#ffb020;text-align:left;font-size:.95rem}
.lang{font-weight:700;text-decoration:none;margin-top:.5rem}
</style>`;

export function renderChoosePage(
  view: ChooseView,
  ctx: { token: string; lang: PayLanguage; device: PayDevice; statementName: string | null; now: Date },
): string {
  const t = PAY_TEXT[ctx.lang];
  const fmt = (c: number): string => formatAmount(c, view.currency, t);
  const withTips = view.tipOptionsCents.length > 1;
  const tips = withTips
    ? `<fieldset><legend>${escapeHtml(t.tipLegend)}</legend><div class="tipgrid">${view.tipOptionsCents
        .map(
          (c) =>
            `<label><input type="radio" name="tip" value="${c}"${c === view.tipCents ? ' checked' : ''}><span>${escapeHtml(
              c === 0 ? t.noTip : `+${formatShort(c, view.currency, t)}`,
            )}</span></label>`,
        )
        .join('')}</div></fieldset>
<p class="total">${escapeHtml(t.total)}: <b id="total">${escapeHtml(fmt(view.amountCents + view.tipCents))}</b></p>`
    : `<input type="hidden" name="tip" value="${view.tipCents}">`;

  // Con wallet: Apple/Google Pay primero y tarjeta debajo. Dentro de Instagram
  // y similares, solo tarjeta. Sin saber el dispositivo, Redsys enseña todo.
  const { wallet, inApp } = ctx.device;
  const buttons = wallet
    ? `<button class="pay" type="submit" name="method" value="wallet">${escapeHtml(t.payWith(wallet))}</button>
<button class="pay alt" type="submit" name="method" value="card">${escapeHtml(t.payCard)}</button>`
    : inApp
      ? `<button class="pay" type="submit" name="method" value="card">${escapeHtml(t.payCard)}</button>`
      : `<button class="pay" type="submit" name="method" value="">${escapeHtml(t.pay)}</button>`;

  const action = `/pay/${encodeURIComponent(ctx.token)}`;
  const other = t.otherLanguage;
  const body = `
<p class="kick">${escapeHtml(t.youPay)}</p>
<div class="amount">${escapeHtml(fmt(view.amountCents))}</div>
<form id="pay" method="POST" action="${escapeHtml(action)}" data-amount="${view.amountCents}" data-currency="${escapeHtml(view.currency)}" data-locale="${t.locale}" data-expires="${view.qrExpiresAt.getTime()}" data-now="${ctx.now.getTime()}">
<input type="hidden" name="lang" value="${ctx.lang}">
${tips}
${inApp ? `<p class="warn" role="note">${escapeHtml(t.inAppWarning(inApp))}</p>` : ''}
${buttons}
</form>
${ctx.statementName ? `<p class="small">${escapeHtml(t.statement(ctx.statementName))}</p>` : ''}
<p class="small">${escapeHtml(t.expiresIn)} <b id="left" style="font-variant-numeric:tabular-nums"></b></p>
<a class="lang" href="${escapeHtml(`${action}?lang=${other.code}`)}" lang="${other.code}" hreflang="${other.code}">${escapeHtml(other.label)}</a>
<script>
(function(){
var f=document.getElementById('pay'),d=f.dataset,base=+d.amount,tot=document.getElementById('total');
function fmt(c){return (c/100).toLocaleString(d.locale,{style:'currency',currency:d.currency});}
function upd(){if(!tot)return;var r=f.querySelector('input[name=tip]:checked');tot.textContent=fmt(base+(r?+r.value:0));}
f.addEventListener('change',upd);upd();
var sent=false;f.addEventListener('submit',function(e){if(sent){e.preventDefault();return;}sent=true;f.className='sending';});
var left=document.getElementById('left'),skew=+d.now-Date.now(),exp=+d.expires,iv;
function tick(){var s=Math.max(0,Math.floor((exp-Date.now()-skew)/1000));left.textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2);if(s<=0){clearInterval(iv);setTimeout(function(){location.reload();},1500);}}
iv=setInterval(tick,1000);tick();
})();
</script>`;
  return page(t, t.youPay, body, CHOOSE_CSS);
}

// ─── Hacia el banco ─────────────────────────────────────────────────────

/**
 * <form> oculto que se envía solo a la pasarela. Botón visible por si el
 * navegador bloquea el envío automático (iOS Safari lo hace a veces). Si el
 * cliente vuelve atrás desde el banco y el navegador restaura esta página,
 * no se reenvía el mismo pedido: se vuelve a la página del cobro.
 */
export function renderCheckoutForm(
  action: string,
  fields: Record<string, string>,
  lang: PayLanguage,
  backHref: string,
): string {
  const t = PAY_TEXT[lang];
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');
  const head = `<style>
.spin{width:2.5rem;height:2.5rem;border:4px solid #2a2a2a;border-top-color:#d4ff3a;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>`;
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1>${escapeHtml(t.openingTitle)}</h1>
<p>${escapeHtml(t.openingHint)}</p>
<form id="f" action="${escapeHtml(action)}" method="POST" accept-charset="UTF-8" style="width:100%">
${inputs}
<button class="btn" type="submit">${escapeHtml(t.continueToBank)}</button>
</form>
<script>
window.addEventListener('pageshow',function(e){if(e.persisted){location.replace(${jsString(backHref)});}});
setTimeout(function(){document.getElementById('f').submit();},250);
</script>`;
  return page(t, t.openingTitle, body, head);
}

// ─── Pagado / comprobando / cerrado ─────────────────────────────────────

export function renderPaidPage(
  args: {
    amountCents: number;
    tipCents: number;
    currency: string;
    code: string;
    authorizedAt: Date | null;
    receiptHref: string | null;
  },
  lang: PayLanguage,
): string {
  const t = PAY_TEXT[lang];
  const css = `<style>
.ok{width:6rem;height:6rem;border-radius:50%;background:#d4ff3a;display:grid;place-items:center}
.ok svg{width:3.2rem;height:3.2rem;stroke:#0b0b0b;stroke-width:3;fill:none}
.code{margin-top:.5rem;border:2px solid #2a2a2a;border-radius:10px;padding:.75rem 1rem;width:100%}
.code b{display:block;font-size:2.4rem;letter-spacing:.3em;color:#d4ff3a}
.clock{font-variant-numeric:tabular-nums;font-size:1.4rem;font-weight:700;color:#f5f5f0}
</style>`;
  const total = formatAmount(args.amountCents + args.tipCents, args.currency, t);
  const body = `
<div class="ok" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>${escapeHtml(t.paidTitle)}</h1>
<div class="amount">${escapeHtml(total)}</div>
${args.tipCents > 0 ? `<p>${escapeHtml(t.includesTip(formatAmount(args.tipCents, args.currency, t)))}</p>` : ''}
${args.authorizedAt ? `<p>${escapeHtml(t.confirmedAt(formatTime(args.authorizedAt, t)))}</p>` : ''}
<div class="code"><p>${escapeHtml(t.codeLabel)}</p><b>${escapeHtml(args.code)}</b><p>${escapeHtml(t.codeHint)}</p></div>
<div class="clock" id="clock" aria-label="${escapeHtml(t.clockLabel)}"></div>
${args.receiptHref ? `<a href="${escapeHtml(args.receiptHref)}">${escapeHtml(t.receiptLink)}</a>` : ''}
<script>
(function(){var el=document.getElementById('clock');function t(){el.textContent=new Date().toLocaleTimeString(${jsString(t.locale)},{timeZone:'Europe/Madrid'});}t();setInterval(t,1000);})();
</script>`;
  return page(t, t.paidTitle, body, css);
}

export function renderProcessingPage(lang: PayLanguage, refreshUrl: string, offerNewCharge = false): string {
  const t = PAY_TEXT[lang];
  const head = `<meta http-equiv="refresh" content="${offerNewCharge ? 5 : 3};url=${escapeHtml(refreshUrl)}"><style>
.spin{width:3rem;height:3rem;border:4px solid #2a2a2a;border-top-color:#d4ff3a;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>`;
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1>${escapeHtml(t.processingTitle)}</h1>
<p>${escapeHtml(t.processingBody)}</p>
${offerNewCharge ? `<p>${escapeHtml(t.processingNewCharge)}</p>` : ''}`;
  return page(t, t.processingTitle, body, head);
}

export function renderMessagePage(
  lang: PayLanguage,
  title: string,
  message: string,
  tone: 'warn' | 'error' | 'neutral',
  action?: { href: string; label: string },
): string {
  const t = PAY_TEXT[lang];
  const color = tone === 'error' ? '#ff5a5f' : tone === 'warn' ? '#ffb020' : '#b4b4ac';
  const body = `
<div style="width:4rem;height:4rem;border-radius:50%;border:3px solid ${color};display:grid;place-items:center" aria-hidden="true">
<svg viewBox="0 0 24 24" style="width:2rem;height:2rem;stroke:${color};stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M12 8v5M12 17h.01"/></svg>
</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${action ? `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ''}`;
  return page(t, title, body);
}

export function renderClosedPage(reason: PayClosedReason, lang: PayLanguage): string {
  const c = PAY_TEXT[lang].closed[reason];
  return renderMessagePage(lang, c.title, c.body, reason === 'canceled' ? 'neutral' : 'warn');
}

export function renderErrorPage(key: PayErrorKey, lang: PayLanguage): string {
  const t = PAY_TEXT[lang];
  return renderMessagePage(lang, t.unavailableTitle, t.errors[key], 'warn');
}

/** /pay/result?op=… — estado REAL del pago; el `status` de la URL no cuenta. */
export function renderResultView(view: PayResultView | null, lang: PayLanguage, refreshUrl: string): string {
  const t = PAY_TEXT[lang];
  if (!view) return renderMessagePage(lang, t.notFoundTitle, t.notFoundBody, 'warn');
  if (PAID_STATES.has(view.status)) {
    return renderPaidPage(
      {
        amountCents: view.amountCents,
        tipCents: view.tipCents,
        currency: view.currency,
        code: confirmationCode(view.paymentId),
        authorizedAt: view.authorizedAt,
        receiptHref: receiptHref(view.qrToken, lang),
      },
      lang,
    );
  }
  const closed = CLOSED_REASON[view.status];
  if (closed) return renderClosedPage(closed, lang);
  if (view.attemptStatus === 'DENIED') {
    return renderMessagePage(lang, t.deniedTitle, t.deniedBody, 'error', {
      href: payHref(view.qrToken, lang),
      label: t.tryAgain,
    });
  }
  return renderProcessingPage(lang, refreshUrl);
}

// ─── Justificante ───────────────────────────────────────────────────────

/** Ds_Card_Brand de Redsys → marca. Desconocida: no se enseña. */
const CARD_BRAND: Record<string, string> = {
  '1': 'Visa',
  '2': 'Mastercard',
  '6': 'Diners',
  '8': 'American Express',
  '9': 'JCB',
  '22': 'UnionPay',
};

export function renderReceiptPage(
  r: PayReceiptView,
  ctx: { lang: PayLanguage; statementName: string | null; backHref: string },
): string {
  const t = PAY_TEXT[ctx.lang];
  const rt = t.receipt;
  const fmt = (c: number): string => formatAmount(c, r.currency, t);
  const brand = r.cardBrand ? CARD_BRAND[r.cardBrand] ?? null : null;
  const method = [r.payMethod === 'wallet' ? rt.wallet : r.payMethod === 'card' ? rt.card : null, brand]
    .filter(Boolean)
    .join(' · ');
  const rows: Array<[string, string, boolean?]> = [
    ...(r.authorizedAt ? [[rt.date, formatDateTime(r.authorizedAt, t)] as [string, string]] : []),
    [rt.amount, fmt(r.amountCents)],
    ...(r.tipCents > 0 ? [[rt.tip, fmt(r.tipCents)] as [string, string]] : []),
    [rt.total, fmt(r.amountCents + r.tipCents), true],
    ...(method ? [[rt.method, method] as [string, string]] : []),
    ...(r.authCode ? [[rt.authCode, r.authCode] as [string, string]] : []),
    ...(r.order ? [[rt.order, r.order] as [string, string]] : []),
    [rt.code, confirmationCode(r.paymentId)],
  ];
  const css = `<style>
dl{width:100%;margin:.5rem 0 0;text-align:left;border-top:2px solid #2a2a2a}
dl div{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid #2a2a2a}
dt{color:#b4b4ac}
dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
dl div.tot dd{color:#d4ff3a;font-size:1.2rem}
@media print{body{background:#fff;color:#000}h1,dd{color:#000}dt,p{color:#333}dl div.tot dd{color:#000}.noprint{display:none}}
</style>`;
  const body = `
<h1>${escapeHtml(rt.title)}</h1>
${ctx.statementName ? `<p>${escapeHtml(ctx.statementName)}</p>` : ''}
<dl>${rows
    .map(
      ([k, v, strong]) =>
        `<div${strong ? ' class="tot"' : ''}><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
    )
    .join('')}</dl>
<button class="btn noprint" type="button" id="print">${escapeHtml(rt.save)}</button>
<a class="noprint" href="${escapeHtml(ctx.backHref)}">${escapeHtml(rt.back)}</a>
<p class="small">${escapeHtml(rt.noPersonalData)}</p>
<script>document.getElementById('print').addEventListener('click',function(){window.print();});</script>`;
  return page(t, rt.title, body, css);
}
