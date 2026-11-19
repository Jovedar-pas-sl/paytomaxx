import { KIT_ASSETS } from './venue-kit';

/**
 * «Plantillas para redes»: una imagen para Instagram con una frase fija, el
 * nombre del local y la marca. Se dibuja en un <canvas> en el navegador; la
 * foto del local (opcional) sale del móvil o del ordenador y no se sube a
 * ningún sitio. Aquí está la cuenta de la composición (sin tocar el DOM, para
 * poder probarla) y, al final, el dibujo.
 */

export const SOCIAL_FORMATS = {
  story: { label: 'Historia', w: 1080, h: 1920 },
  post: { label: 'Publicación', w: 1080, h: 1080 },
} as const;
export type SocialFormat = keyof typeof SOCIAL_FORMATS;

/** Las únicas frases posibles (no hay texto libre): solo lo que OxioPay hace hoy. */
export const SOCIAL_PHRASES = [
  'Ya puedes pagar con OxioPay',
  'Escanea, paga y sigue la noche',
  'Sin app ni registro: paga desde tu móvil',
] as const;

const INK = '#1F2C36';
const CREAM = '#EFE9DF';
const LIME = '#C7D301';
/** Con foto: una capa oscura encima para que el texto crema se lea (≥ 4,5:1 incluso sobre blanco puro). */
export const PHOTO_OVERLAY_ALPHA = 0.68;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TextLine {
  text: string;
  x: number;
  y: number;
}
export interface SocialLayout {
  w: number;
  h: number;
  /** Márgenes seguros: en la historia, más arriba y abajo para lo que tapa la app. */
  safe: { top: number; bottom: number; side: number };
  symbol: Box;
  phraseFont: number;
  phraseLineHeight: number;
  phrase: TextLine[];
  venueFont: number;
  venue: TextLine;
  wordmark: Box;
}

const SAFE = {
  story: { top: 250, bottom: 340, side: 96 },
  post: { top: 96, bottom: 96, side: 96 },
} as const;
const PHRASE_FONT = { story: 108, post: 92 } as const;
const MAX_PHRASE_LINES = { story: 6, post: 4 } as const;
const MIN_PHRASE_FONT = 52;
const MIN_VENUE_FONT = 30;
/** El nombre escrito solo mide 256 px de ancho: más grande se vería borroso. */
const WORDMARK_W = 280;
const WORDMARK_ASPECT = 51 / 256;

export type Measure = (text: string, fontPx: number) => number;

/** Parte el texto en líneas que caben en `maxWidth`; una palabra más larga que la línea se queda sola. */
export function wrapText(text: string, fontPx: number, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, fontPx) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** El nombre del local en una línea: se reduce la letra y, en último caso, se corta con «…». */
export function fitVenueName(name: string, startFont: number, maxWidth: number, measure: Measure): { text: string; font: number } {
  const clean = name.replace(/\s+/g, ' ').trim();
  let font = startFont;
  while (font > MIN_VENUE_FONT && measure(clean, font) > maxWidth) font -= 2;
  let text = clean;
  while (text.length > 1 && measure(text, font) > maxWidth) text = `${text.slice(0, -2).trimEnd()}…`;
  return { text, font };
}

/** Recorte «cover»: la parte de la foto (en sus píxeles) que llena el lienzo sin deformarse. */
export function coverCrop(imgW: number, imgH: number, w: number, h: number): Box {
  const scale = Math.max(w / imgW, h / imgH);
  const sw = w / scale;
  const sh = h / scale;
  return { x: (imgW - sw) / 2, y: (imgH - sh) / 2, w: sw, h: sh };
}

export function computeLayout(format: SocialFormat, phrase: string, venueName: string, measure: Measure): SocialLayout {
  const { w, h } = SOCIAL_FORMATS[format];
  const safe = SAFE[format];
  const maxW = w - safe.side * 2;
  const cx = w / 2;

  let phraseFont: number = PHRASE_FONT[format];
  let lines = wrapText(phrase, phraseFont, maxW, measure);
  while (lines.length > MAX_PHRASE_LINES[format] && phraseFont > MIN_PHRASE_FONT) {
    phraseFont -= 4;
    lines = wrapText(phrase, phraseFont, maxW, measure);
  }
  const lineH = Math.round(phraseFont * 1.14);
  const symSize = format === 'story' ? 190 : 150;
  const venue = fitVenueName(venueName, format === 'story' ? 52 : 46, maxW, measure);
  const wmH = Math.round(WORDMARK_W * WORDMARK_ASPECT);

  // Todo el bloque (símbolo, frase, local) centrado entre los márgenes; el nombre escrito, abajo.
  const gap = format === 'story' ? 70 : 52;
  const blockH = symSize + gap + lines.length * lineH + gap + venue.font;
  const wordmarkY = h - safe.bottom - wmH;
  const areaH = wordmarkY - 60 - safe.top;
  const top = safe.top + Math.max(0, (areaH - blockH) / 2);
  const phraseTop = top + symSize + gap;
  const venueBase = phraseTop + lines.length * lineH + gap + venue.font * 0.8;

  return {
    w,
    h,
    safe,
    symbol: { x: cx - symSize / 2, y: top, w: symSize, h: symSize },
    phraseFont,
    phraseLineHeight: lineH,
    phrase: lines.map((text, i) => ({ text, x: cx, y: phraseTop + i * lineH + phraseFont * 0.82 })),
    venueFont: venue.font,
    venue: { text: venue.text, x: cx, y: venueBase },
    wordmark: { x: cx - WORDMARK_W / 2, y: wordmarkY, w: WORDMARK_W, h: wmH },
  };
}

/** Contraste WCAG entre dos colores #RRGGBB (para comprobar el texto sobre la capa oscura). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** El color de un fondo blanco puro tras la capa oscura: el peor caso de una foto. */
export function worstCasePhotoBackground(): string {
  const v = Math.round(255 * (1 - PHOTO_OVERLAY_ALPHA) + 11 * PHOTO_OVERLAY_ALPHA);
  const hx = v.toString(16).padStart(2, '0');
  return `#${hx}${hx}${hx}`;
}

export const SOCIAL_TEXT_COLOR = CREAM;

export interface SocialDrawOptions {
  format: SocialFormat;
  phrase: string;
  venueName: string;
  /** La foto del local, ya cargada en el navegador; null = fondo liso. */
  photo: ImageBitmap | HTMLImageElement | null;
  symbol: CanvasImageSource;
  wordmark: CanvasImageSource;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('No se ha podido cargar el logo.'));
    im.src = src;
  });
}

/** El símbolo y el nombre escrito (claro, para fondo oscuro), cargados una vez. */
export async function loadBrandImages(): Promise<{ symbol: HTMLImageElement; wordmark: HTMLImageElement }> {
  const [symbol, wordmark] = await Promise.all([loadImage(KIT_ASSETS.symbol), loadImage(KIT_ASSETS.wordmarkLight)]);
  return { symbol, wordmark };
}

/** Dibuja la plantilla en el lienzo (se le pone el tamaño del formato). Espera a las letras de la página. */
export async function drawSocialTemplate(canvas: HTMLCanvasElement, o: SocialDrawOptions): Promise<void> {
  await document.fonts.ready;
  const { w, h } = SOCIAL_FORMATS[o.format];
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Este navegador no puede dibujar la imagen.');
  const sans = "'Instrument Sans', system-ui, sans-serif";
  const measure: Measure = (text, px) => {
    ctx.font = `600 ${px}px ${sans}`;
    return ctx.measureText(text).width;
  };
  const L = computeLayout(o.format, o.phrase, o.venueName, measure);

  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, w, h);
  if (o.photo) {
    const c = coverCrop(o.photo.width, o.photo.height, w, h);
    ctx.drawImage(o.photo, c.x, c.y, c.w, c.h, 0, 0, w, h);
    ctx.fillStyle = `rgba(11,13,14,${PHOTO_OVERLAY_ALPHA})`;
    ctx.fillRect(0, 0, w, h);
  }

  // El símbolo es cuadrado y de fondo crema: va en una pastilla con las esquinas redondeadas.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(L.symbol.x, L.symbol.y, L.symbol.w, L.symbol.h, L.symbol.w * 0.2);
  ctx.clip();
  ctx.drawImage(o.symbol, L.symbol.x, L.symbol.y, L.symbol.w, L.symbol.h);
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.fillStyle = CREAM;
  ctx.font = `600 ${L.phraseFont}px ${sans}`;
  for (const line of L.phrase) ctx.fillText(line.text, line.x, line.y);

  // Una raya lima (solo de acento) entre la frase y el nombre del local.
  const last = L.phrase[L.phrase.length - 1];
  if (last) {
    ctx.fillStyle = LIME;
    ctx.fillRect(w / 2 - 48, last.y + 34, 96, 8);
  }
  ctx.fillStyle = CREAM;
  ctx.font = `600 ${L.venueFont}px ${sans}`;
  ctx.fillText(L.venue.text, L.venue.x, L.venue.y);
  ctx.drawImage(o.wordmark, L.wordmark.x, L.wordmark.y, L.wordmark.w, L.wordmark.h);
}

/** PNG del lienzo; si el navegador no puede, error con palabras claras. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se ha podido crear la imagen.'))), 'image/png');
  });
}
