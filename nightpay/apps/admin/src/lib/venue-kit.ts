import { escapeHtml } from './home-topup';

/**
 * «Material para el local» (Ajustes → Formas de cobro): tres hojas A4 para
 * imprimir y pegar en el local. Solo se dice lo que OxioPay hace hoy (los
 * textos salen de la portada y de la página /r del enlace del local). Cada
 * línea va en español y, debajo y más pequeña, en inglés. Todo es de un solo
 * color de tinta sobre blanco: sale bien en una impresora en blanco y negro;
 * el lima solo acompaña (un punto, una raya).
 */

/** Las imágenes de marca, en un solo sitio (para cambiarlas por SVG cuando los haya). */
export const KIT_ASSETS = {
  /** El símbolo sin fondo (512×512, nítido): para lo impreso. Sale de scripts/brand/transparent-symbol.mjs. */
  symbol: '/brand/oxio-simbolo-512.png',
  /** El símbolo con su fondo crema (pastilla): para las plantillas de redes sobre foto. */
  symbolTile: '/icons/icon-512.png',
  /** El nombre escrito (256×51): solo pequeño (≤ 45 mm impreso). */
  wordmarkDark: '/brand/oxiopay-wordmark-oscuro.png',
  wordmarkLight: '/brand/oxiopay-wordmark-claro.png',
} as const;

export interface KitOptions {
  /** Nombre del local (dato del usuario: se escapa). */
  venueName: string;
  /** El QR del enlace /r del local; null si «Cargar saldo desde casa» está apagado: entonces no hay QR. */
  qr: string | null;
  /** Origen del panel (para las imágenes de marca en la ventana nueva); '' si son relativas. */
  assetBase?: string;
  /** Las letras de la marca (URLs absolutas de los woff2): la hoja se abre desde un blob y no hereda las de la página. */
  fonts?: { sans: string; num: string };
}

interface Line {
  es: string;
  en: string;
}

export const KIT_TEXT = {
  payTitle: { es: 'Paga con OxioPay', en: 'Pay with OxioPay' },
  payMethods: {
    es: 'Tarjeta · Apple Pay · Google Pay · Tu saldo',
    en: 'Card · Apple Pay · Google Pay · Your balance',
  },
  /** Cómo paga el cliente en la barra. */
  barSteps: [
    { es: 'El personal te enseña el QR.', en: 'The staff shows you the QR.' },
    { es: 'Escanéalo con la cámara del móvil. Sin app ni registro.', en: 'Scan it with your phone camera. No app, no sign-up.' },
    { es: 'Paga con tarjeta, Apple Pay, Google Pay o tu saldo.', en: 'Pay with card, Apple Pay, Google Pay or your balance.' },
  ] as readonly Line[],
  qrCaption: { es: 'Carga o mira tu saldo', en: 'Top up or check your balance' },
  doorTitle: { es: 'Aquí se paga con OxioPay', en: 'We accept OxioPay' },
  receptionTitle: { es: 'Carga tu saldo aquí', en: 'Top up here' },
  /** Recepción: importe, pago en efectivo o tarjeta y el saldo listo. */
  receptionSteps: [
    { es: 'Dinos cuánto quieres cargar.', en: 'Tell us how much you want to top up.' },
    { es: 'Paga en efectivo o con tarjeta.', en: 'Pay in cash or by card.' },
    { es: 'Listo: paga con tu saldo en el local.', en: 'All set: pay with your balance at the venue.' },
  ] as readonly Line[],
  receptionQrCaption: { es: 'O cárgalo antes de llegar, desde tu móvil', en: 'Or top up before you arrive, from your phone' },
  keepNote: {
    es: 'Lo que te sobra se queda en tu saldo para tu próxima visita.',
    en: 'Anything left over stays in your balance for your next visit.',
  },
} as const;

const BASE_CSS = `
@page{size:A4;margin:0}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;color:#1f2c36;background:#fff;font-family:OxioSans,'Instrument Sans',system-ui,'Segoe UI',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,p,ol{margin:0}
.en{color:#46525c;font-weight:400}
.num{font-family:OxioNum,Manrope,'Instrument Sans',system-ui,sans-serif}
.page{width:210mm;height:297mm;position:relative;overflow:hidden;page-break-after:always;break-after:page}
.page:last-child{page-break-after:auto;break-after:auto}
.cut{position:absolute;border:0 dashed #8a949c}
.dot{display:inline-block;width:.42em;height:.42em;border-radius:.12em;background:#c7d301;margin-right:.35em;vertical-align:.05em}
`;

/** Instrument Sans (texto) y Manrope (cifras): las mismas que el panel, variables, con sus pesos. */
function fontFaces(f: KitOptions['fonts']): string {
  if (!f) return '';
  const safe = (u: string): string => u.replace(/["'\s)]/g, '');
  const face = (name: string, url: string, weight: string): string =>
    `@font-face{font-family:${name};src:url("${safe(url)}") format('woff2');font-weight:${weight};font-display:block}`;
  return face('OxioSans', f.sans, '400 700') + face('OxioNum', f.num, '600 800');
}

function head(title: string, css: string, o: KitOptions): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${fontFaces(o.fonts)}${BASE_CSS}${css}</style></head>`;
}

function img(base: string | undefined, path: string, alt: string, cls: string): string {
  return `<img class="${cls}" src="${escapeHtml(`${base ?? ''}${path}`)}" alt="${escapeHtml(alt)}">`;
}

function bi(l: Line, esTag = 'span'): string {
  return `<${esTag}>${escapeHtml(l.es)}</${esTag}><${esTag} class="en" lang="en">${escapeHtml(l.en)}</${esTag}>`;
}

function steps(list: readonly Line[]): string {
  return `<ol class="steps">${list.map((s, i) => `<li><b class="num">${i + 1}</b><div>${bi(s, 'p')}</div></li>`).join('')}</ol>`;
}

function qrBlock(o: KitOptions, caption: Line, cls: string): string {
  if (!o.qr) return '';
  return `<figure class="${cls}"><img class="qr" src="${escapeHtml(o.qr)}" alt="QR"><figcaption>${bi(caption, 'p')}</figcaption></figure>`;
}

const STEPS_CSS = `
.steps{list-style:none;padding:0;display:flex;flex-direction:column;gap:5mm}
.steps li{display:flex;gap:4mm;align-items:flex-start}
.steps b{flex:none;width:9mm;height:9mm;border-radius:50%;border:.7mm solid #1f2c36;display:flex;align-items:center;justify-content:center;font-size:15pt}
.steps p:first-child{font-size:14pt;font-weight:600;line-height:1.25}
.steps p.en{font-size:10.5pt;line-height:1.25}
figure{margin:0;text-align:center}
figcaption p:first-child{font-size:12pt;font-weight:600}
figcaption p.en{font-size:9.5pt}
.qr{display:block;margin:0 auto 3mm;background:#fff}
`;

/** «Expositor de barra»: un A4 que se dobla por la mitad; las dos caras iguales (la de arriba, del revés). */
export function counterTentHtml(o: KitOptions): string {
  const t = KIT_TEXT;
  const face = (flip: boolean): string => `<section class="face${flip ? ' flip' : ''}">
<div class="txt">${img(o.assetBase, KIT_ASSETS.symbol, 'OxioPay', 'sym')}
<h1><span class="dot"></span>${escapeHtml(t.payTitle.es)}</h1><p class="en h1en" lang="en">${escapeHtml(t.payTitle.en)}</p>
${steps(t.barSteps)}</div>${qrBlock(o, t.qrCaption, 'qrcol')}</section>`;
  const css = `${STEPS_CSS}
.face{position:absolute;left:0;width:210mm;height:148.5mm;padding:12mm 14mm;display:flex;gap:10mm;align-items:center}
.face{top:148.5mm}.flip{top:0;transform:rotate(180deg)}
.txt{flex:1;display:flex;flex-direction:column;gap:5mm}
.sym{width:20mm;height:20mm;border-radius:4mm}
h1{font-size:30pt;line-height:1.05;font-weight:600}.h1en{font-size:14pt;margin-top:-3mm}
.qrcol{flex:none;width:62mm}.qr{width:62mm;height:62mm}
.fold{left:0;top:148.5mm;width:210mm;border-top-width:.35mm}
.m{width:6mm;border-top-width:.35mm}`;
  return `${head(t.payTitle.es, css, o)}<body><div class="page">${face(true)}${face(false)}
<div class="cut fold"></div><div class="cut m" style="left:0;top:0"></div><div class="cut m" style="right:0;top:0"></div><div class="cut m" style="left:0;bottom:0"></div><div class="cut m" style="right:0;bottom:0"></div>
</div></body></html>`;
}

/** Las pegatinas de puerta: redondas de 100 mm, cuatro en un A4 (dos y dos). */
export function doorStickersHtml(o: KitOptions): string {
  const t = KIT_TEXT;
  const sticker = `<div class="st">${img(o.assetBase, KIT_ASSETS.symbol, 'OxioPay', 'sym')}
<h1>${escapeHtml(t.doorTitle.es)}</h1><p class="en h1en" lang="en">${escapeHtml(t.doorTitle.en)}</p>
<p class="meth">${escapeHtml(t.payMethods.es)}</p><p class="en meth" lang="en">${escapeHtml(t.payMethods.en)}</p></div>`;
  const css = `
.page{display:grid;grid-template-columns:100mm 100mm;grid-template-rows:100mm 100mm;gap:4mm;justify-content:center;align-content:center}
.st{width:100mm;height:100mm;border-radius:50%;border:.5mm dashed #8a949c;outline:2mm solid #1f2c36;outline-offset:-5mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:14mm 13mm;gap:1.5mm}
.sym{width:26mm;height:26mm;border-radius:5mm;margin-bottom:1.5mm}
h1{font-size:17pt;line-height:1.08;font-weight:600}.h1en{font-size:11pt}
.meth{font-size:8pt;line-height:1.25}.meth:not(.en){margin-top:2mm;font-weight:600}`;
  return `${head(t.doorTitle.es, css, o)}<body><div class="page">${sticker.repeat(4)}</div></body></html>`;
}

/** El cartel de recepción: A4 con «Carga tu saldo aquí», tres pasos y, si se puede, el QR del local. */
export function receptionPosterHtml(o: KitOptions): string {
  const t = KIT_TEXT;
  const css = `${STEPS_CSS}
.page{padding:16mm 18mm;display:flex;flex-direction:column;gap:9mm}
.top{display:flex;justify-content:space-between;align-items:center}
.sym{width:24mm;height:24mm;border-radius:4.5mm}
.venue{font-size:14pt;font-weight:600;text-align:right;max-width:110mm;overflow-wrap:anywhere}
h1{font-size:46pt;line-height:1;font-weight:600}.h1en{font-size:22pt;margin-top:2mm}
.steps p:first-child{font-size:18pt}.steps p.en{font-size:12pt}.steps b{width:12mm;height:12mm;font-size:19pt}
.qrcol{align-self:center;margin-top:auto}.qr{width:80mm;height:80mm}figcaption p:first-child{font-size:14pt}figcaption p.en{font-size:11pt}
.note{border-top:.4mm solid #1f2c36;padding-top:4mm;font-size:11pt}.note .en{font-size:9pt}
.wm{height:9mm;width:auto;margin-top:2mm}`;
  return `${head(t.receptionTitle.es, css, o)}<body><div class="page">
<div class="top">${img(o.assetBase, KIT_ASSETS.symbol, 'OxioPay', 'sym')}<p class="venue">${escapeHtml(o.venueName)}</p></div>
<div><h1><span class="dot"></span>${escapeHtml(t.receptionTitle.es)}</h1><p class="en h1en" lang="en">${escapeHtml(t.receptionTitle.en)}</p></div>
${steps(t.receptionSteps)}
${qrBlock(o, t.receptionQrCaption, 'qrcol')}
<div class="note">${bi(t.keepNote, 'p')}${img(o.assetBase, KIT_ASSETS.wordmarkDark, 'OxioPay', 'wm')}</div>
</div></body></html>`;
}
