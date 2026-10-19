import { cardBrandLabel } from './card-brand';
import { CLUB_BASE_CSS, escapeHtml, jsConfig, jsString } from './club-ui';
import { PAID_SCREEN_CSS, paidScreenScript, renderPaidScreen } from './paid-screen';
import { WALLET_ASK_CSS, renderWalletAsk, type WalletBlock } from './paid-wallet-ask';
import type { PayDevice } from './pay-device';
import { PAY_TEXT, type PayErrorKey, type PayLanguage, type PayNotice, type PayText } from './pay-i18n';
import {
  CLOSED_REASON,
  PAID_STATES,
  confirmationCode,
  type PayClosedReason,
  type PayReceiptView,
  type PayRedirect,
  type PayResultView,
} from './pay-redirect';
import { tipPresetsFor } from './tip';

export type { WalletBlock } from './paid-wallet-ask';

/**
 * Páginas del cliente en /pay/... (Fase 1B). Look "Club" (club-ui.ts):
 * negro + lima, letra grande, muy simple. HTML autocontenido (sin fuentes
 * externas: la CSP del API no las permite y el cliente puede tener mala red).
 * Todo el texto sale de pay-i18n.
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

const PAGE_CSS = `
.c{width:100%;max-width:26rem;margin:0 auto;min-height:100vh;min-height:100svh;padding:1.5rem 1rem 2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.8rem;text-align:center}
.c.top{justify-content:flex-start;padding-top:2rem}
.amount{font-size:clamp(3rem,16vw,4.25rem);font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--fg)}
.small{font-size:.9rem}
.foot{margin-top:1.25rem}
`;

function formatAmount(cents: number, currency: string, t: PayText): string {
  return (cents / 100).toLocaleString(t.locale, { style: 'currency', currency });
}

/** "65 €" en vez de "65,00 €" (botón «Pagar 65 €» y propinas). */
function formatShort(cents: number, currency: string, t: PayText): string {
  return (cents / 100).toLocaleString(t.locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
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

/** /pay/:token: rutas del Face ID del saldo en "Pagado". */
export function payBase(payToken: string): string {
  return `/pay/${encodeURIComponent(payToken)}`;
}

export function walletHref(token: string, lang: PayLanguage): string {
  return `/w/${encodeURIComponent(token)}?lang=${lang}`;
}

export function receiptHref(token: string, lang: PayLanguage): string {
  return `/pay/${encodeURIComponent(token)}/receipt?lang=${lang}`;
}

/**
 * Esqueleto común. `full`: el cuerpo va a todo el ancho (el «Pagado»);
 * `top`: columna arriba (página de pago); por defecto, columna centrada.
 */
function page(
  t: PayText,
  title: string,
  body: string,
  opts: { head?: string; layout?: 'center' | 'top' | 'full' } = {},
): string {
  const layout = opts.layout ?? 'center';
  const footer = `<p class="foot">${escapeHtml(t.secure)}</p>`;
  const main =
    layout === 'full'
      ? `<main>${body}</main>`
      : `<main class="c${layout === 'top' ? ' top' : ''}">${body}\n${footer}</main>`;
  return `<!DOCTYPE html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0b0b"><title>${escapeHtml(title)}</title>
<style>${CLUB_BASE_CSS}${PAGE_CSS}</style>${opts.head ?? ''}
</head><body>
${main}
</body></html>`;
}

// ─── Página de pago ─────────────────────────────────────────────────────

const CHOOSE_CSS = `<style>
.c.top{padding-bottom:11rem}
.trust{width:100%;display:flex;flex-direction:column;align-items:center;gap:.45rem;padding-bottom:.5rem}
.venue{font-size:.95rem;font-weight:700;color:var(--fg);letter-spacing:.02em}
.concept{font-size:.95rem}
.stmt{font-size:.85rem;color:var(--dim)}
form{width:100%;display:flex;flex-direction:column;gap:.8rem}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{color:var(--mute);margin:0 auto .6rem;padding:0;font-weight:600}
.tipgrid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
.tipgrid label{display:block;position:relative}
.tipgrid input{position:absolute;opacity:0;width:1px;height:1px}
.tipgrid span{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:3.5rem;padding:.5rem 1.4rem;border:2px solid var(--line);border-radius:12px;font-weight:800;color:var(--fg);cursor:pointer;transition:transform .15s var(--ease)}
.tipgrid small{font-size:.8rem;font-weight:600;color:var(--mute)}
.tipgrid input:checked+span{border-color:var(--lime);background:#1b2208;color:var(--lime);box-shadow:inset 0 0 0 1px var(--lime)}
.tipgrid input:checked+span::before{content:'✓';position:absolute;top:.35rem;right:.55rem;font-size:.9rem;font-weight:900}
.tipgrid input:checked+span small{color:var(--lime)}
.tipgrid input:focus-visible+span{outline:3px solid var(--fg);outline-offset:2px}
.tipgrid span:active{transform:scale(.97)}
.other{display:flex;flex-direction:column;align-items:center;gap:.35rem;margin-top:.7rem}
.other label{font-weight:600;color:var(--mute)}
.eur{display:flex;align-items:center;gap:.4rem}
.eur input{width:7rem;min-height:3.25rem;font:inherit;font-size:1.6rem;font-weight:800;text-align:center;border-radius:12px;border:2px solid var(--lime);background:var(--surface);color:var(--fg)}
.eur span{font-size:1.4rem;font-weight:800}
.tipnote{margin-top:.6rem;font-size:.9rem;color:var(--fg)}
.total{color:var(--fg);font-size:1.05rem}
.warn{border:2px solid var(--warn);border-radius:12px;padding:.75rem 1rem;color:var(--warn);text-align:left;font-size:.95rem}
.paybar{position:fixed;left:0;right:0;bottom:0;z-index:5;padding:1.25rem 1rem calc(.75rem + env(safe-area-inset-bottom));background:linear-gradient(to top,var(--bg) 72%,rgba(11,11,11,0))}
.paybar>div{max-width:26rem;margin:0 auto;display:flex;flex-direction:column;gap:.45rem;text-align:center}
.paybar .btn{min-height:3.75rem;font-size:1.25rem}
.methods{font-size:.85rem;color:var(--mute)}
</style>`;

function tipChoices(view: ChooseView, t: PayText): string {
  const presets = tipPresetsFor(view.amountCents);
  const short = (c: number): string => formatShort(c, view.currency, t);
  const pct = (p: number): string => (p / 100).toLocaleString(t.locale, { style: 'percent' });
  const options = view.tipOptionsCents
    .filter((c) => c > 0)
    .map((c) => {
      const percent = presets.find((p) => p.cents === c)?.percent ?? null;
      const label = percent
        ? `<b>${escapeHtml(pct(percent))}</b><small class="num">+${escapeHtml(short(c))}</small>`
        : `<b class="num">+${escapeHtml(short(c))}</b>`;
      return `<label><input type="radio" name="tip" value="${c}"><span>${label}</span></label>`;
    })
    .join('');
  // «Otra» necesita JS: empieza oculta y el JS la enseña.
  const canOther = view.tipMaxCents >= 100;
  return `<fieldset><legend>${escapeHtml(t.tipLegend)}</legend><div class="tipgrid">
<label><input type="radio" name="tip" value="0" checked><span>${escapeHtml(t.noTip)}</span></label>${options}${
    canOther
      ? `<label id="otherOpt" hidden><input type="radio" name="tip" value="0" id="otherRadio"><span>${escapeHtml(t.tipOther)}</span></label>`
      : ''
  }</div>
${
  canOther
    ? `<div class="other" id="otherBox" hidden><label for="otherIn">${escapeHtml(t.tipOtherLabel)}</label>
<div class="eur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-describedby="otherMax"><span aria-hidden="true">€</span></div>
<p class="small" id="otherMax">${escapeHtml(t.tipMax(short(Math.floor(view.tipMaxCents / 100) * 100)))}</p></div>`
    : ''
}${view.tipToStaff ? `<p class="tipnote">${escapeHtml(t.tipToStaff)}</p>` : ''}</fieldset>
<p class="total" aria-live="polite">${escapeHtml(t.total)}: <b class="num" id="total">${escapeHtml(formatAmount(view.amountCents, view.currency, t))}</b></p>`;
}

export function renderChoosePage(
  view: ChooseView,
  ctx: { token: string; lang: PayLanguage; device: PayDevice; statementName: string | null; now: Date },
): string {
  const t = PAY_TEXT[ctx.lang];
  const withTips = (view.tipMaxCents ?? 0) > 0;
  // Un solo botón: el banco enseña Apple Pay, Google Pay y tarjeta (las marcas
  // no permiten botones de wallet hechos a mano ni traducidos). Dentro de
  // Instagram y similares, solo tarjeta (ahí Apple Pay / Google Pay no van).
  const { inApp, wallet } = ctx.device;
  const action = `/pay/${encodeURIComponent(ctx.token)}`;
  const other = t.otherLanguage;
  const config = jsConfig({
    amount: view.amountCents,
    currency: view.currency,
    locale: t.locale,
    max: view.tipMaxCents ?? 0,
    text: { pay: t.payPrefix, sending: t.sending },
  });
  const body = `
<header class="trust">
${view.venueName ? `<p class="venue">${escapeHtml(view.venueName)}</p>` : ''}
<h1 class="amount num"><span class="sr">${escapeHtml(t.youPay)}: </span>${escapeHtml(formatAmount(view.amountCents, view.currency, t))}</h1>
${view.concept ? `<p class="concept">${escapeHtml(view.concept)}</p>` : ''}
${ctx.statementName ? `<p class="stmt">${escapeHtml(t.statement(ctx.statementName))}</p>` : ''}
</header>
<form id="pay" method="POST" action="${escapeHtml(action)}" data-expires="${view.qrExpiresAt.getTime()}" data-now="${ctx.now.getTime()}">
<input type="hidden" name="lang" value="${ctx.lang}">
${withTips ? tipChoices(view, t) : '<input type="hidden" name="tip" value="0">'}
${inApp ? `<p class="warn" role="note">${escapeHtml(t.inAppWarning(inApp))}</p>` : ''}
<div class="paybar"><div>
<input type="hidden" name="method" value="${inApp ? 'card' : wallet ? 'wallet' : ''}">
<button class="btn" id="payBtn" type="submit">${escapeHtml(`${t.payPrefix} ${formatShort(view.amountCents, view.currency, t)}`)}</button>
<p class="methods">${escapeHtml(inApp ? t.methodsCard : wallet ? t.methodsWallet(wallet) : t.methods)}</p>
${!inApp && wallet ? `<button class="link" id="cardBtn" type="button">${escapeHtml(t.payByCard)}</button>` : ''}
</div></div>
</form>
<p class="small">${escapeHtml(t.expiresIn)} <b class="num" id="left"></b></p>
<a class="link" href="${escapeHtml(`${action}?lang=${other.code}`)}" lang="${other.code}" hreflang="${other.code}">${escapeHtml(other.label)}</a>
<script>
(function(){
var C=JSON.parse(${config}),T=C.text,f=document.getElementById('pay'),btn=document.getElementById('payBtn'),tot=document.getElementById('total'),
 other=document.getElementById('otherRadio'),box=document.getElementById('otherBox'),inp=document.getElementById('otherIn'),sent=false;
function money(c,short){return (c/100).toLocaleString(C.locale,{style:'currency',currency:C.currency,minimumFractionDigits:short&&c%100===0?0:2});}
function otherCents(){var e=parseInt(inp.value.replace(/[^0-9]/g,'')||'0',10),max=Math.floor(C.max/100);if(e>max){e=max;inp.value=String(e);}return e*100;}
function tip(){var r=f.querySelector('input[name=tip]:checked');return r?(+r.value||0):0;}
function upd(){if(other){box.hidden=!other.checked;other.value=String(other.checked?otherCents():0);}
 var sum=C.amount+tip();if(!sent)btn.textContent=T.pay+' '+money(sum,true);if(tot)tot.textContent=money(sum,false);}
if(other){document.getElementById('otherOpt').hidden=false;inp.addEventListener('input',upd);}
f.addEventListener('change',function(e){upd();if(other&&e.target===other&&other.checked)inp.focus();});
f.addEventListener('submit',function(e){if(sent){e.preventDefault();return;}upd();sent=true;
 btn.textContent=T.sending;btn.setAttribute('aria-disabled','true');f.setAttribute('aria-busy','true');});
var cb=document.getElementById('cardBtn'),m0=f.elements.method.value;
if(cb)cb.addEventListener('click',function(){if(sent)return;f.elements.method.value='card';if(f.requestSubmit)f.requestSubmit(btn);else{upd();sent=true;f.submit();}});
window.addEventListener('pageshow',function(e){if(e.persisted){sent=false;f.elements.method.value=m0;btn.removeAttribute('aria-disabled');f.removeAttribute('aria-busy');upd();}});
upd();
var left=document.getElementById('left'),d=f.dataset,skew=+d.now-Date.now(),exp=+d.expires,iv;
function tick(){var s=Math.max(0,Math.floor((exp-Date.now()-skew)/1000));left.textContent=Math.floor(s/60)+':'+('0'+s%60).slice(-2);if(s<=0){clearInterval(iv);setTimeout(function(){location.reload();},1500);}}
iv=setInterval(tick,1000);tick();
})();
</script>`;
  return page(t, t.youPay, body, { head: CHOOSE_CSS, layout: 'top' });
}

// ─── Hacia el banco ─────────────────────────────────────────────────────

const SPIN_CSS = `<style>
.spin{width:3rem;height:3rem;border:4px solid var(--line);border-top-color:var(--lime);border-radius:50%;animation:np-spin 1s linear infinite}
@keyframes np-spin{to{transform:rotate(360deg)}}
@keyframes np-breathe{from{opacity:.35}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.spin{animation:np-breathe 1.5s ease-in-out infinite alternate}}
</style>`;

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
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1 role="status">${escapeHtml(t.openingTitle)}</h1>
<p>${escapeHtml(t.openingHint)}</p>
<form id="f" action="${escapeHtml(action)}" method="POST" accept-charset="UTF-8" style="width:100%">
${inputs}
<button class="btn" type="submit">${escapeHtml(t.continueToBank)}</button>
</form>
<script>
window.addEventListener('pageshow',function(e){if(e.persisted){location.replace(${jsString(backHref)});}});
setTimeout(function(){document.getElementById('f').submit();},250);
</script>`;
  return page(t, t.openingTitle, body, { head: SPIN_CSS });
}

// ─── Pagado ─────────────────────────────────────────────────────────────

export function renderPaidPage(
  args: {
    amountCents: number;
    tipCents: number;
    currency: string;
    code: string;
    authorizedAt: Date | null;
    receiptHref: string | null;
    /** Recarga de saldo: enlace a la página del saldo. */
    walletHref?: string | null;
    /** Recarga de saldo vista desde otro navegador: sin enlace, con aviso. */
    walletElsewhere?: boolean;
    /** Recarga que creó el saldo, en el móvil que pagó: activar Face ID. */
    wallet?: WalletBlock | null;
    /** Hora del servidor (para «hace 0:12» y para saber si es un enlace ya pagado). */
    now?: Date;
  },
  lang: PayLanguage,
): string {
  const t = PAY_TEXT[lang];
  const now = args.now ?? new Date();
  const lines =
    args.tipCents > 0 ? [t.includesTip(formatAmount(args.tipCents, args.currency, t))] : [];
  const screen = renderPaidScreen({
    t,
    amount: formatAmount(args.amountCents + args.tipCents, args.currency, t),
    authorizedAt: args.authorizedAt,
    now,
    code: args.code,
    lines,
  });
  const walletLinks = args.walletHref
    ? `${args.wallet ? '' : `<p>${escapeHtml(t.walletReady)}</p>`}
<a class="btn${args.wallet ? ' alt' : ''}" href="${escapeHtml(args.walletHref)}">${escapeHtml(t.walletOpen)}</a>
${args.wallet && !args.wallet.hasFaceId ? `<a class="link" id="fidMerge" href="${escapeHtml(`${args.walletHref}#sumar`)}">${escapeHtml(t.mergeHint)}</a>` : ''}`
    : '';
  const next = `<section class="next">
${args.wallet ? renderWalletAsk(args.wallet, t) : ''}
${walletLinks}
${!args.walletHref && args.walletElsewhere ? `<p>${escapeHtml(t.walletElsewhere)}</p>` : ''}
${args.receiptHref ? `<a class="link" href="${escapeHtml(args.receiptHref)}">${escapeHtml(t.receiptLink)}</a>` : ''}
<p class="foot">${escapeHtml(t.secure)}</p>
</section>`;
  const head = `<style>${PAID_SCREEN_CSS}${WALLET_ASK_CSS}</style>`;
  return page(t, t.paidTitle, `${screen}\n${next}\n${paidScreenScript(t)}`, { head, layout: 'full' });
}

// ─── Comprobando ────────────────────────────────────────────────────────

export function renderProcessingPage(lang: PayLanguage, refreshUrl: string, offerNewCharge = false): string {
  const t = PAY_TEXT[lang];
  const head = `<meta http-equiv="refresh" content="${offerNewCharge ? 5 : 3};url=${escapeHtml(refreshUrl)}">${SPIN_CSS}`;
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1 role="status">${escapeHtml(t.processingTitle)}</h1>
<p>${escapeHtml(t.processingBody)}</p>
${offerNewCharge ? `<p class="small">${escapeHtml(t.processingNewCharge)}</p>` : ''}`;
  return page(t, t.processingTitle, body, { head });
}

// ─── Avisos: qué pasó, si no se cobró nada y UNA acción ─────────────────

const NOTICE_CSS = `<style>
.ico{width:4.5rem;height:4.5rem;border-radius:50%;border:3px solid currentColor;display:grid;place-items:center}
.ico svg{width:2.25rem;height:2.25rem;stroke:currentColor;stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
.ico.error{color:var(--err)}.ico.warn{color:var(--warn)}.ico.neutral{color:var(--mute)}
h1{font-size:1.75rem}
.safe{display:flex;align-items:center;gap:.5rem;padding:.55rem .9rem;border-radius:999px;background:#1b2208;color:var(--lime);font-weight:800}
.safe svg{width:1.2rem;height:1.2rem;stroke:currentColor;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;flex:none}
.hint{width:100%;margin-top:.5rem;padding:.9rem 1rem;border-left:4px solid var(--lime);border-radius:4px;background:var(--surface);color:var(--fg);font-weight:700;text-align:left}
</style>`;

/** Icono distinto según el tono (el estado no lo dice solo el color). */
const NOTICE_ICON: Record<'error' | 'warn' | 'neutral', string> = {
  error: '<path d="M7 7l10 10M17 7L7 17"/>',
  warn: '<path d="M12 7v6M12 17h.01"/>',
  neutral: '<path d="M12 11v6M12 7h.01"/>',
};

/**
 * Aviso al cliente. Si el aviso tiene botón (`retry`) y hay a dónde volver,
 * la acción es el botón; si no, la indicación (`hint`). Nunca las dos.
 */
export function renderNoticePage(
  lang: PayLanguage,
  notice: PayNotice,
  tone: 'error' | 'warn' | 'neutral',
  retryHref?: string,
): string {
  const t = PAY_TEXT[lang];
  const action =
    notice.retry && retryHref
      ? `<a class="btn" href="${escapeHtml(retryHref)}">${escapeHtml(notice.retry)}</a>`
      : notice.hint
        ? `<p class="hint">${escapeHtml(notice.hint)}</p>`
        : '';
  const body = `
<div class="ico ${tone}" aria-hidden="true"><svg viewBox="0 0 24 24">${NOTICE_ICON[tone]}</svg></div>
<h1>${escapeHtml(notice.title)}</h1>
${notice.notCharged ? `<p class="safe" id="notCharged"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>${escapeHtml(t.notCharged)}</p>` : ''}
${notice.body ? `<p>${escapeHtml(notice.body)}</p>` : ''}
${action}`;
  return page(t, notice.title, body, { head: NOTICE_CSS });
}

export function renderClosedPage(reason: PayClosedReason, lang: PayLanguage): string {
  return renderNoticePage(lang, PAY_TEXT[lang].closed[reason], reason === 'canceled' ? 'neutral' : 'warn');
}

/** Error al abrir o empezar el cobro. Nunca enseña el detalle técnico ni códigos del banco. */
export function renderErrorPage(key: PayErrorKey, lang: PayLanguage, retryHref?: string): string {
  return renderNoticePage(lang, PAY_TEXT[lang].errors[key], 'warn', retryHref);
}

/** /pay/result?op=… — estado REAL del pago; el `status` de la URL no cuenta. */
export function renderResultView(
  view: PayResultView | null,
  lang: PayLanguage,
  refreshUrl: string,
  walletElsewhere = false,
  now: Date = new Date(),
): string {
  const t = PAY_TEXT[lang];
  if (!view) return renderNoticePage(lang, t.notFound, 'warn');
  if (PAID_STATES.has(view.status)) {
    return renderPaidPage(
      {
        amountCents: view.amountCents,
        tipCents: view.tipCents,
        currency: view.currency,
        code: confirmationCode(view.paymentId),
        authorizedAt: view.authorizedAt,
        receiptHref: receiptHref(view.qrToken, lang),
        walletHref: view.walletToken ? walletHref(view.walletToken, lang) : null,
        walletElsewhere,
        wallet:
          view.walletToken && view.walletCode
            ? { hasFaceId: view.walletHasFaceId, base: payBase(view.qrToken) }
            : null,
        now,
      },
      lang,
    );
  }
  const closed = CLOSED_REASON[view.status];
  if (closed) return renderClosedPage(closed, lang);
  if (view.attemptStatus === 'DENIED') {
    // Mensaje genérico: nunca el código del banco (ni de fraude ni ningún otro).
    return renderNoticePage(lang, t.denied, 'error', payHref(view.qrToken, lang));
  }
  return renderProcessingPage(lang, refreshUrl);
}

// ─── Justificante ───────────────────────────────────────────────────────

export function renderReceiptPage(
  r: PayReceiptView,
  ctx: { lang: PayLanguage; statementName: string | null; backHref: string },
): string {
  const t = PAY_TEXT[ctx.lang];
  const rt = t.receipt;
  const fmt = (c: number): string => formatAmount(c, r.currency, t);
  const brand = cardBrandLabel(r.cardBrand);
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
dl{width:100%;margin:.5rem 0 0;text-align:left;border-top:2px solid var(--line)}
dl div{display:flex;justify-content:space-between;gap:1rem;padding:.65rem 0;border-bottom:1px solid var(--line)}
dt{color:var(--mute)}
dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
dl div.tot dd{color:var(--lime);font-size:1.25rem}
@media print{body{background:#fff;color:#000}h1,dd{color:#000}dt,p{color:#333}dl div.tot dd{color:#000}.noprint{display:none!important}}
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
<a class="link noprint" href="${escapeHtml(ctx.backHref)}">${escapeHtml(rt.back)}</a>
<p class="small">${escapeHtml(rt.noPersonalData)}</p>
<script>document.getElementById('print').addEventListener('click',function(){window.print();});</script>`;
  return page(t, rt.title, body, { head: css });
}
