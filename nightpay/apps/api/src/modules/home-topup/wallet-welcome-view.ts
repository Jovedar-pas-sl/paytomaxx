import { escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/customer-lang';
import { HOME_TOPUP_TEXT } from './home-topup-text';

/**
 * Lo que «Cargar saldo antes de llegar» pinta en la página del saldo (/w),
 * aparte para no mezclarlo con lo de siempre (wallet-page.ts lo llama):
 *  - la bienvenida del saldo nuevo cargado desde casa (?nuevo=<cobro>):
 *    debajo del «Pagado», qué hacer al llegar y «Guardar el enlace»;
 *  - el QR de la ficha en «Tu código» (saldo activo sin ficha y el local da
 *    fichas): recepción lo escanea y le da una ficha unida a su saldo.
 * Sin barras invertidas en el JS (va dentro de una plantilla).
 */

export const WELCOME_CSS = `
.wel{gap:.6rem}
.wel .kick{color:var(--lime)}
.wel .done{text-align:center}
.fqr{display:flex;flex-direction:column;align-items:center;gap:.55rem;margin-top:.35rem;padding-top:.85rem;border-top:1px solid var(--line);text-align:center}
.fqr .fqrt{color:var(--fg);font-weight:800}
.fqri{width:min(15rem,72vw);padding:.4rem;border-radius:18px;background:var(--cream);box-shadow:0 0 0 3px var(--lime-edge)}
.fqri svg{display:block;width:100%;height:auto}
`;

/** «Tu saldo está listo»: debajo del «Pagado» de la carga que lo creó. */
export function welcomeCard(lang: PayLanguage, venueName: string | null): string {
  const t = HOME_TOPUP_TEXT[lang];
  const h = escapeHtml;
  const title = venueName ? t.welcomeTitle.split('{venue}').join(venueName) : t.welcomeTitleNoVenue;
  return `<section class="card main wel" id="welcome" aria-labelledby="welTitle">
<p class="kick">${h(t.welcomeKick)}</p>
<h2 id="welTitle">${h(title)}</h2>
<p>${h(t.welcomeBody)}</p>
<p class="small">${h(t.saveLink)}</p>
<button class="btn alt" type="button" id="welShare">${h(t.shareLink)}</button>
<p class="small done" id="welCopied" role="status" hidden>${h(t.copied)}</p>
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
 * welcomeRender(s): con la ficha ya dada (o el saldo cerrado), el QR se quita.
 * «Guardar el enlace»: el menú de compartir del móvil o, sin él, copiarlo.
 */
export const WELCOME_JS = `
function welcomeRender(s){var q=$('fichaQr');if(q)q.hidden=!!s.hasCard||s.status!=='ACTIVE';}
var welShare=$('welShare');if(welShare)welShare.addEventListener('click',function(){var u=location.origin+C.base;
 if(navigator.share){navigator.share({url:u,title:document.title}).catch(function(){});return;}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(u).then(function(){$('welCopied').hidden=false;}).catch(function(){});});`;
