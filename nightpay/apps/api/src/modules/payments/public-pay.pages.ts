import { cardBrandLabel } from './card-brand';
import { CLUB_BASE_CSS, clientMoney, escapeHtml, jsString } from './club-ui';
import { CHROME_CSS, defaultLangHref, langHrefWith, langScript, topBar, type LangHref } from './customer-chrome';
import { CHOOSE_CSS, LOCK_ICON, renderChooseBody, type ChooseContext } from './pay-choose-page';
import { PAID_SCREEN_CSS, paidScreenScript, renderPaidScreen } from './paid-screen';
import { WALLET_ASK_CSS, renderWalletAsk, type WalletBlock } from './paid-wallet-ask';
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

export type { WalletBlock } from './paid-wallet-ask';

/**
 * Páginas del cliente en /pay/... (Fase 1B). Marca OxioCard (club-ui.ts):
 * noche + pill lima, «Pagado» en verde, letra grande, muy simple. Arriba de
 * todas, el logo y el selector de idioma (customer-chrome.ts). HTML
 * autocontenido (sin fuentes de fuera: la CSP del API no las permite y el
 * cliente puede tener mala red; la de la marca la sirve el propio API). Todo
 * el texto sale de i18n/ (un archivo por idioma).
 */

type ChooseView = Extract<PayRedirect, { kind: 'choose' }>;

const PAGE_CSS = `
.c{width:100%;max-width:26rem;margin:0 auto;min-height:calc(100vh - 3.5rem);min-height:calc(100svh - 3.5rem);padding:1rem 1rem 2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.8rem;text-align:center}
.amount{font-size:clamp(3rem,16vw,4.25rem);font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--fg)}
.small{font-size:.9rem}
.foot{margin-top:1.25rem}
`;

/**
 * Un importe en la pantalla del cliente: «65 €» (sin «,00», como en el móvil
 * del personal: decisión D4), «65,50 €», «1.109 €» (en inglés, «€65.50»).
 */
function formatAmount(cents: number, currency: string, t: PayText): string {
  return clientMoney(cents, t.locale, currency);
}

/**
 * El justificante es un documento: con céntimos y en su formato de siempre
 * («65,00 €», «1109,00 €»: el del idioma, sin el punto de los miles en 4
 * cifras). No usa el formato de las pantallas (decisión del dueño).
 */
function formatFull(cents: number, currency: string, t: PayText): string {
  return (cents / 100).toLocaleString(t.locale, { style: 'currency', currency });
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

/** Vuelta a /w tras pagar una recarga empezada allí: el saldo con su «Pagado». */
export function walletReturnHref(walletToken: string, payToken: string, lang: PayLanguage): string {
  return `${walletHref(walletToken, lang)}&pagado=${encodeURIComponent(payToken)}`;
}

export function receiptHref(token: string, lang: PayLanguage): string {
  return `/pay/${encodeURIComponent(token)}/receipt?lang=${lang}`;
}

/**
 * Esqueleto común: la barra de arriba (logo e idioma) y el cuerpo. `full`:
 * el cuerpo va a todo el ancho (el «Pagado», con la barra encima); `bare`:
 * el cuerpo pone su propio <main> (la página de pago); por defecto, columna
 * centrada con «Pago seguro» al pie.
 */
function page(
  t: PayText,
  title: string,
  body: string,
  opts: { head?: string; layout?: 'center' | 'full' | 'bare'; langHref?: LangHref } = {},
): string {
  const layout = opts.layout ?? 'center';
  const hrefFor = opts.langHref ?? defaultLangHref;
  const lang = t.htmlLang;
  const main =
    layout === 'full'
      ? `${topBar(lang, hrefFor, { over: true })}\n<main>${body}</main>`
      : layout === 'bare'
        ? `${topBar(lang, hrefFor)}\n${body}`
        : `${topBar(lang, hrefFor)}\n<main class="c">${body}\n<p class="foot">${escapeHtml(t.secure)}</p></main>`;
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0f1112"><title>${escapeHtml(title)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${PAGE_CSS}</style>${opts.head ?? ''}
</head><body>
${main}
${langScript()}
</body></html>`;
}

// ─── Página de pago ─────────────────────────────────────────────────────

export function renderChoosePage(view: ChooseView, ctx: ChooseContext): string {
  const t = PAY_TEXT[ctx.lang];
  return page(t, t.youPay, renderChooseBody(view, ctx), { head: `<style>${CHOOSE_CSS}</style>`, layout: 'bare' });
}

// ─── Hacia el banco ─────────────────────────────────────────────────────

const SPIN_CSS = `<style>
.spin{width:3rem;height:3rem;border:4px solid var(--line-hi);border-top-color:var(--lime);border-radius:50%;animation:np-spin 1s linear infinite}
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
  // Cambiar de idioma aquí vuelve a la página del cobro (este formulario ya está abierto en el banco).
  const back = backHref.split('?')[0] ?? backHref;
  return page(t, t.openingTitle, body, { head: SPIN_CSS, langHref: (l) => `${back}?lang=${l}` });
}

// ─── Pagado ─────────────────────────────────────────────────────────────

export function renderPaidPage(
  args: {
    amountCents: number;
    tipCents: number;
    /** «Comisión del servicio» que pagó (0 sin ella): va dentro del total. */
    serviceFeeCents?: number;
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
    /** Este navegador hizo el pago aprobado (su cookie): solo él ve el «Pagado» lima. */
    viewerPaid?: boolean;
    /** Una recarga del saldo: la primera línea del desglose es «Recarga». */
    topUp?: boolean;
    /** El selector de idioma de esta página (p. ej. /pay/result?op=…). */
    langHref?: LangHref;
  },
  lang: PayLanguage,
): string {
  const t = PAY_TEXT[lang];
  const now = args.now ?? new Date();
  const fee = args.serviceFeeCents ?? 0;
  const money = (c: number): string => formatAmount(c, args.currency, t);
  // Con comisión o propina, el desglose: lo pedido, la comisión y la propina.
  const rows: Array<readonly [string, string]> =
    fee > 0 || args.tipCents > 0
      ? [
          [args.topUp ? t.breakdown.topUp : t.breakdown.consumption, money(args.amountCents)],
          ...(fee > 0 ? [[t.breakdown.serviceFee, money(fee)] as const] : []),
          ...(args.tipCents > 0 ? [[t.breakdown.tip, money(args.tipCents)] as const] : []),
        ]
      : [];
  const receipt = args.receiptHref ? `<a class="link" href="${escapeHtml(args.receiptHref)}">${escapeHtml(t.receiptLink)}</a>` : '';
  const screen = renderPaidScreen({
    t,
    amount: money(args.amountCents + fee + args.tipCents),
    authorizedAt: args.authorizedAt,
    now,
    code: args.code,
    rows,
    lines: args.tipCents > 0 ? [t.thanksTip] : [],
    viewerPaid: args.viewerPaid === true,
    // Sin recarga que activar, el justificante va dentro del «Pagado» (se ve sin bajar).
    footer: args.walletHref || args.walletElsewhere ? '' : receipt,
  });
  const walletLinks = args.walletHref
    ? `${args.wallet ? '' : `<p>${escapeHtml(t.walletReady)}</p>`}
<a class="btn${args.wallet ? ' alt' : ''}" href="${escapeHtml(args.walletHref)}">${escapeHtml(t.walletOpen)}</a>
${args.wallet && !args.wallet.hasFaceId ? `<a class="link" id="fidMerge" href="${escapeHtml(`${args.walletHref}#sumar`)}">${escapeHtml(t.mergeHint)}</a>` : ''}`
    : '';
  const withWallet = Boolean(args.walletHref || args.walletElsewhere);
  const next = `<section class="next">
${args.wallet ? renderWalletAsk(args.wallet, t) : ''}
${walletLinks}
${!args.walletHref && args.walletElsewhere ? `<p>${escapeHtml(t.walletElsewhere)}</p>` : ''}
${withWallet ? receipt : ''}
<p class="foot secure">${LOCK_ICON}${escapeHtml(t.secure)}</p>
</section>`;
  const head = `<style>${PAID_SCREEN_CSS}${WALLET_ASK_CSS}.secure{display:flex;align-items:center;gap:.4rem}.secure svg{width:1rem;height:1rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}</style>`;
  return page(t, t.paidTitle, `${screen}\n${next}\n${paidScreenScript(t)}`, {
    head,
    layout: 'full',
    langHref: args.langHref,
  });
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
  return page(t, t.processingTitle, body, { head, langHref: sameUrlOtherLang(refreshUrl) });
}

/** El mismo enlace (con sus parámetros, p. ej. ?op=) en otro idioma. */
function sameUrlOtherLang(url: string): LangHref {
  const [path, query = ''] = url.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return langHrefWith(path ?? url, params);
}

/**
 * Demasiadas peticiones desde esta IP (el wifi del local): espera `seconds` y
 * vuelve a cargar la misma página. Sin «no se te ha cobrado»: no lo sabemos.
 */
export function renderBusyPage(lang: PayLanguage, againHref: string, seconds: number): string {
  const t = PAY_TEXT[lang];
  const head = `<meta http-equiv="refresh" content="${Math.max(1, Math.round(seconds))};url=${escapeHtml(againHref)}">${SPIN_CSS}`;
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1 role="status">${escapeHtml(t.busyTitle)}</h1>
<p>${escapeHtml(t.busyBody)}</p>`;
  return page(t, t.busyTitle, body, { head, langHref: sameUrlOtherLang(againHref) });
}

// ─── Avisos: qué pasó, si no se cobró nada y UNA acción ─────────────────

const NOTICE_CSS = `<style>
.ico{width:5.5rem;height:5.5rem;border-radius:50%;display:grid;place-items:center;background:var(--surface-2);box-shadow:inset 0 0 0 3px currentColor}
.ico svg{width:2.6rem;height:2.6rem;stroke:currentColor;stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
.ico.error{color:var(--bad);background:rgb(255 90 95/.16)}.ico.warn{color:var(--warn);background:rgb(255 176 32/.12)}.ico.neutral{color:var(--mute)}
h1{font-size:1.75rem}
.safe{display:flex;align-items:center;gap:.5rem;padding:.55rem .9rem;border-radius:999px;background:var(--lime-soft);border:1.5px solid var(--lime-edge);color:var(--fg);font-weight:800}
.safe svg{color:var(--lime)}
.safe svg{width:1.2rem;height:1.2rem;stroke:currentColor;stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;flex:none}
.hint{width:100%;margin-top:.5rem;padding:.9rem 1rem;border:1px solid var(--line);border-radius:var(--r-tile);background:var(--surface);color:var(--fg);font-weight:700;text-align:left}
</style>`;

/** Icono distinto según el tono (el estado no lo dice solo el color). */
const NOTICE_ICON: Record<'error' | 'warn' | 'neutral', string> = {
  error: '<path d="M7 7l10 10M17 7L7 17"/>',
  warn: '<path d="M12 7v6M12 17h.01"/>',
  neutral: '<path d="M12 11v6M12 7h.01"/>',
};

/**
 * Aviso al cliente. Si el aviso tiene botón (`retry`) y hay a dónde volver,
 * la acción es el botón; si no, la indicación (`hint`). Nunca las dos. El
 * botón vuelve a la página del cobro, donde sigue la propina elegida.
 */
export function renderNoticePage(
  lang: PayLanguage,
  notice: PayNotice,
  tone: 'error' | 'warn' | 'neutral',
  retryHref?: string,
  langHref?: LangHref,
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
  return page(t, notice.title, body, { head: NOTICE_CSS, langHref });
}

export function renderClosedPage(reason: PayClosedReason, lang: PayLanguage, langHref?: LangHref): string {
  const tone = reason === 'canceled' || reason === 'paid-with-saldo' ? 'neutral' : 'warn';
  return renderNoticePage(lang, PAY_TEXT[lang].closed[reason], tone, undefined, langHref);
}

/** Error al abrir o empezar el cobro. Nunca enseña el detalle técnico ni códigos del banco. */
export function renderErrorPage(key: PayErrorKey, lang: PayLanguage, retryHref?: string): string {
  // Cambiar de idioma lleva a la página del cobro (la del aviso es la respuesta de un POST).
  const back = retryHref?.split('?')[0];
  return renderNoticePage(lang, PAY_TEXT[lang].errors[key], 'warn', retryHref, back ? (l) => `${back}?lang=${l}` : undefined);
}

/** /pay/result?op=… — estado REAL del pago; el `status` de la URL no cuenta. */
export function renderResultView(
  view: PayResultView | null,
  lang: PayLanguage,
  refreshUrl: string,
  opts: { walletElsewhere?: boolean; viewerPaid?: boolean; now?: Date; topUp?: boolean } = {},
): string {
  const { walletElsewhere = false, viewerPaid = false, now = new Date(), topUp = false } = opts;
  const t = PAY_TEXT[lang];
  const langHref = sameUrlOtherLang(refreshUrl);
  if (!view) return renderNoticePage(lang, t.notFound, 'warn', undefined, langHref);
  if (PAID_STATES.has(view.status)) {
    return renderPaidPage(
      {
        amountCents: view.amountCents,
        tipCents: view.tipCents,
        serviceFeeCents: view.serviceFeeCents ?? 0,
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
        viewerPaid,
        topUp: topUp || Boolean(view.walletToken || view.walletReturnToken),
        langHref,
      },
      lang,
    );
  }
  const closed = CLOSED_REASON[view.status];
  if (closed) return renderClosedPage(closed, lang, langHref);
  if (view.attemptStatus === 'DENIED') {
    // Mensaje genérico: nunca el código del banco (ni de fraude ni ningún otro).
    return renderNoticePage(lang, t.denied, 'error', payHref(view.qrToken, lang), langHref);
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
  const fmt = (c: number): string => formatFull(c, r.currency, t);
  const brand = cardBrandLabel(r.cardBrand);
  const method = [r.payMethod === 'wallet' ? rt.wallet : r.payMethod === 'card' ? rt.card : null, brand]
    .filter(Boolean)
    .join(' · ');
  const rows: Array<[string, string, boolean?]> = [
    ...(r.authorizedAt ? [[rt.date, formatDateTime(r.authorizedAt, t)] as [string, string]] : []),
    [r.topUp ? rt.topUp : rt.amount, fmt(r.amountCents)],
    ...((r.serviceFeeCents ?? 0) > 0 ? [[rt.serviceFee, fmt(r.serviceFeeCents ?? 0)] as [string, string]] : []),
    ...(r.tipCents > 0 ? [[rt.tip, fmt(r.tipCents)] as [string, string]] : []),
    [rt.total, fmt(r.amountCents + (r.serviceFeeCents ?? 0) + r.tipCents), true],
    ...(method ? [[rt.method, method] as [string, string]] : []),
    ...(r.authCode ? [[rt.authCode, r.authCode] as [string, string]] : []),
    ...(r.order ? [[rt.order, r.order] as [string, string]] : []),
    [rt.code, confirmationCode(r.paymentId)],
  ];
  const css = `<style>
dl{width:100%;margin:.5rem 0 0;padding:0 1rem;text-align:left;border:1px solid var(--line);border-radius:var(--r);background:var(--surface)}
dl div{display:flex;justify-content:space-between;gap:1rem;padding:.65rem 0;border-bottom:1px solid var(--line)}
dl div:last-child{border-bottom:0}
dt{color:var(--mute)}
dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
dl div.tot dt{color:var(--fg);font-weight:800}
dl div.tot dd{color:var(--lime);font-size:1.25rem}
@media print{body{background:#fff;color:#000}h1,dd{color:#000}dt,p{color:#333}dl{background:none}dl div.tot dd{color:#000}.noprint,.brand{display:none!important}}
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
