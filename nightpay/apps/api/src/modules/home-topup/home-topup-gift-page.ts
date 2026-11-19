import { CLUB_BASE_CSS, clientMoney, escapeHtml } from '../payments/club-ui';
import { CHROME_CSS, LANG_JS, langHrefWith, topBar } from '../payments/customer-chrome';
import { legalFooter } from '../legal/legal-links';
import { PAY_TEXT, type PayLanguage } from '../payments/pay-i18n';
import { myBalanceBlock } from '../wallets/my-balance';
import { WALLET_TEXT } from '../wallets/wallet-text';
import { HOME_TOPUP_TEXT } from './home-topup-text';
import { giftTerms } from './home-topup-page';
import { GIFT_PATH_PREFIX } from './home-topup-rules';
import type { GiftState } from './home-topup-gift';

/** Lo que pinta la página del regalo (/r/regalo/<token>). */
export interface GiftPageView {
  state: GiftState;
  venueName: string;
  /** Lo regalado (sin la comisión del servicio). */
  amountCents: number;
  toName: string | null;
  message: string | null;
  expiresAt: Date;
}

/**
 * Las fechas del regalo, en la hora de España.
 * shortcut: Europe/Madrid fijo; si hay locales en otra zona, la del local.
 */
const GIFT_TIME_ZONE = 'Europe/Madrid';

const GIFT_CSS = `
.h{max-width:26rem;margin:0 auto;padding:.25rem 1rem calc(2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:1rem}
.card{border:1px solid var(--line);border-radius:var(--r);padding:1rem;display:flex;flex-direction:column;gap:.75rem;background:var(--surface)}
.card h1{font-size:1.5rem;line-height:1.25;color:var(--fg)}
.card.off{border-color:var(--warn)}
.gfor{color:var(--fg);font-weight:600}
.gmsg{margin:0;padding:.75rem .875rem;border-left:3px solid var(--lime);border-radius:var(--r-tile);background:var(--surface-2);color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere}
.small{font-size:.875rem}
.glink{width:100%;min-height:2.75rem;padding:0 .75rem;border:1px solid var(--line-hi);border-radius:var(--r-tile);background:var(--surface-2);color:var(--fg);font:inherit;font-size:.875rem}
.terms{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.75rem}
.terms li{display:grid;grid-template-columns:1.5rem 1fr;gap:.625rem;align-items:start;color:var(--mute);font-size:.875rem;line-height:1.45}
.terms li svg{width:1.25rem;height:1.25rem;margin-top:.05rem;fill:none;stroke:var(--mute);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
form{margin:0}`;

function fill(text: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), text);
}

/** El enlace del regalo, entero (para compartirlo). `origin`: el del API. */
export function giftUrl(origin: string, token: string): string {
  return `${origin}${GIFT_PATH_PREFIX}${encodeURIComponent(token)}`;
}

/**
 * La página del regalo:
 *  - de quien lo recibe: «Te han regalado 50 € en Sala Aurora», su nombre y
 *    el mensaje (texto plano, escapado: ningún enlace se pinta como enlace) y
 *    «Guardar en mi móvil» (POST: emite el QR de activación de siempre);
 *  - de quien lo pagó (`share`, al volver de pagar): «Comparte tu regalo», el
 *    enlace, «Enviar por WhatsApp» (wa.me/?text=), «Copiar enlace» y las
 *    condiciones (GIFT_LEGAL_TEXT). Sin «Guardar»;
 *  - guardado o caducado: lo dice, sin nada del saldo (a nadie).
 * Mirarla no cambia nada (las vistas previas de WhatsApp la abren).
 */
export function renderGiftPage(token: string, lang: PayLanguage, view: GiftPageView, opts: { share: boolean; origin: string }): string {
  const t = HOME_TOPUP_TEXT[lang].gift;
  const w = WALLET_TEXT[lang];
  const h = escapeHtml;
  const path = `${GIFT_PATH_PREFIX}${encodeURIComponent(token)}`;
  const amount = clientMoney(view.amountCents, w.locale);
  const share = opts.share && view.state === 'open';
  const body =
    view.state === 'claimed'
      ? `<section class="card" aria-labelledby="gTitle"><h1 id="gTitle">${h(t.claimedTitle)}</h1><p>${h(t.claimedBody)}</p>
${myBalanceBlock(lang, { withPasskeyJs: true })}</section>`
      : view.state === 'expired'
        ? `<section class="card off" aria-labelledby="gTitle"><h1 id="gTitle">${h(t.expiredTitle)}</h1><p>${h(t.expiredBody)}</p></section>`
        : share
          ? shareCard(lang, view, giftUrl(opts.origin, token), amount)
          : receiveCard(lang, view, path, amount);
  const langHref = langHrefWith(path, { comprado: share ? '1' : null });
  return `<!DOCTYPE html>
<html lang="${PAY_TEXT[lang].htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0b0d0e"><title>${h(`${share ? t.shareTitle : t.title} · ${view.venueName}`)}</title>
<style>${CLUB_BASE_CSS}${CHROME_CSS}${GIFT_CSS}</style></head><body>
${topBar(lang, langHref)}
<main class="h">
${body}
</main>
${legalFooter(lang)}
<script>${share ? COPY_JS : ''}${LANG_JS}</script>
</body></html>`;
}

/** Quien lo recibe: lo regalado, su nombre, el mensaje y «Guardar en mi móvil». */
function receiveCard(lang: PayLanguage, view: GiftPageView, path: string, amount: string): string {
  const t = HOME_TOPUP_TEXT[lang].gift;
  const w = WALLET_TEXT[lang];
  const h = escapeHtml;
  const date = new Intl.DateTimeFormat(w.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: GIFT_TIME_ZONE }).format(view.expiresAt);
  const title = h(fill(t.received, { amount, venue: view.venueName }));
  return `<section class="card" aria-labelledby="gTitle">
<h1 id="gTitle">${title}</h1>
${view.toName ? `<p class="gfor">${h(fill(t.forName, { name: view.toName }))}</p>` : ''}${view.message ? `<p class="gmsg">${h(view.message)}</p>` : ''}
<form method="post" action="${h(`${path}/guardar?lang=${lang}`)}"><button class="btn" type="submit">${h(t.save)}</button></form>
<p class="small">${h(t.saveHint)}</p>
<p class="small">${h(fill(t.saveBefore, { date }))}</p>
</section>`;
}

/** Quien lo pagó: el enlace para compartirlo y las condiciones. */
function shareCard(lang: PayLanguage, view: GiftPageView, url: string, amount: string): string {
  const t = HOME_TOPUP_TEXT[lang].gift;
  const h = escapeHtml;
  const wa = `https://wa.me/?text=${encodeURIComponent(fill(t.shareText, { amount, venue: view.venueName, url }))}`;
  return `<section class="card" aria-labelledby="gTitle">
<h1 id="gTitle">${h(t.shareTitle)}</h1>
<p>${h(fill(t.shareBody, { amount, venue: view.venueName }))}</p>
${view.toName ? `<p class="gfor">${h(fill(t.forName, { name: view.toName }))}</p>` : ''}${view.message ? `<p class="gmsg">${h(view.message)}</p>` : ''}
<label class="small" for="gUrl">${h(t.shareLinkLabel)}</label>
<input class="glink" id="gUrl" readonly value="${h(url)}">
<a class="btn" href="${h(wa)}" target="_blank" rel="noopener noreferrer">${h(t.shareWhatsapp)}</a>
<button class="btn alt" type="button" id="gCopy" data-done="${h(t.shareCopied)}">${h(t.shareCopy)}</button>
<p class="small">${h(t.sharePrivate)}</p>
<ul class="terms">
${giftTerms(lang, view.venueName)}
</ul>
</section>`;
}

/** «Copiar enlace» (sin barras invertidas: va dentro de una plantilla). */
const COPY_JS = `(function(){var b=document.getElementById('gCopy'),i=document.getElementById('gUrl');if(!b||!i)return;
b.addEventListener('click',function(){var done=function(){b.textContent=b.getAttribute('data-done');};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(i.value).then(done,function(){i.select();});}else{i.select();}});})();
`;
