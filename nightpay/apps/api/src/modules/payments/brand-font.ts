import { createHash } from 'node:crypto';
import { MANROPE_WOFF2_BASE64 } from './brand-font-manrope';
import { INSTRUMENT_SANS_WOFF2_BASE64 } from './brand-font-sans';

/**
 * Las letras de las páginas del cliente (/pay, /s, /w, /r), las mismas de las
 * apps (Grafito): Instrument Sans para todo el texto y Manrope variable solo
 * para las cifras. Servidas desde el propio API: la CSP solo deja 'self'
 * (nada de Google Fonts) y el cliente puede tener mala red (≈64 KB las dos,
 * en caché un año; mientras llegan, la del sistema: font-display swap). Son
 * los mismos ficheros de packages/ui/fonts: brand-font.spec.ts comprueba que
 * no se separan.
 */

/** Los bytes de cada woff2 (lo que sirve BrandFontController). */
export const MANROPE_WOFF2: Buffer = Buffer.from(MANROPE_WOFF2_BASE64, 'base64');
export const SANS_WOFF2: Buffer = Buffer.from(INSTRUMENT_SANS_WOFF2_BASE64, 'base64');

/** Dónde se sirven (fuera de /v1, como el resto de /pay). */
export const MANROPE_PATH = '/pay/assets/manrope.woff2';
export const SANS_PATH = '/pay/assets/instrument-sans.woff2';

/** Con su versión: se guarda un año en caché y, si cambia la fuente, cambia la URL. */
function versioned(path: string, bytes: Buffer): string {
  return `${path}?v=${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}`;
}

export const MANROPE_URL = versioned(MANROPE_PATH, MANROPE_WOFF2);
export const SANS_URL = versioned(SANS_PATH, SANS_WOFF2);

/**
 * Las familias de las páginas: «OxioSans» y «OxioManrope» (no sus nombres de
 * siempre, para no mezclarse con una copia instalada en el móvil con otros
 * pesos). Los pesos son los que trae cada fichero: el texto pide 400-600 y
 * las cifras 600-700; nunca 800 ni 900.
 */
export const BRAND_FONT_FACE =
  `@font-face{font-family:'OxioSans';src:url('${SANS_URL}') format('woff2');font-weight:400 700;font-style:normal;font-display:swap}` +
  `@font-face{font-family:'OxioManrope';src:url('${MANROPE_URL}') format('woff2');font-weight:600 800;font-style:normal;font-display:swap}`;
