import type { DeviceInfo } from '@nightpay/contracts';
import { clientIp, type ClientIpRequest } from './client-ip';

/**
 * El dispositivo de quien hace una petición (lógica pura): modelo, sistema y
 * su versión, navegador, si es un móvil y si va dentro de otra app. Lo que se
 * guarda con el cobro (evento `payment.device`) y se enseña en su detalle;
 * nunca el User-Agent entero.
 *
 *  - iPhone no da el modelo: queda «iPhone · iOS 18».
 *  - Android lo da con client hints: el API pide Sec-CH-UA-Model y
 *    Sec-CH-UA-Platform-Version (Accept-CH en sus páginas; las apps del
 *    personal, en su next.config) y el navegador las manda después.
 *  - Android con el User-Agent recortado de Chrome («Android 10; K») y sin
 *    client hints: sin modelo ni versión (los de ese texto son de mentira).
 */

/** Lo que se pide al navegador en las páginas del cliente (y en las apps del personal). */
export const CLIENT_HINTS_ACCEPT_CH = 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version';

/** Las cabeceras de las que sale (las demás no se guardan en el contexto). */
export const DEVICE_HEADERS = [
  'user-agent',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-model',
  'sec-ch-ua-platform-version',
] as const;

/** El dispositivo y la IP de la petición (RequestContext.device). */
export interface ClientDevice extends DeviceInfo {
  ip: string | null;
}

type Headers = Record<string, string | string[] | undefined>;

/**
 * Navegadores de dentro de una app: el enlace abierto desde Instagram,
 * Facebook o TikTok (ahí Apple Pay y Google Pay no van: pay-device.ts).
 */
export const IN_APP_BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Instagram/i, 'Instagram'],
  [/FBAN|FBAV|FB_IAB|FBIOS|Messenger/i, 'Facebook'],
  [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok'],
  [/Snapchat/i, 'Snapchat'],
  [/LinkedInApp/i, 'LinkedIn'],
  [/\bLine\//i, 'LINE'],
];

/** En orden: los que se anuncian también como Chrome o Safari van antes. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:EdgiOS|EdgA|Edg)\/(\d+)/, 'Edge'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/(?:OPR|OPiOS|OPT)\/(\d+)/, 'Opera'],
  [/CriOS\/(\d+)/, 'Chrome'],
  [/(?:FxiOS|Firefox)\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[.\d]*(?: Mobile\/\S+)? Safari\//, 'Safari'],
];

/** Marcas de Sec-CH-UA → el nombre de siempre. */
const BRAND_NAMES: Readonly<Record<string, string>> = {
  'Google Chrome': 'Chrome',
  'Microsoft Edge': 'Edge',
  'Opera GX': 'Opera',
};

const MAX_PART = 40;

export function headerValue(headers: Headers, name: string): string | null {
  const v = headers[name];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.trim() ? first.trim() : null;
}

/** Solo letras, cifras y lo normal de un modelo (nada que acabe en una página sin escapar), corto. */
function clean(value: string | null | undefined): string | null {
  const v = (value ?? '').replace(/[^\p{L}\p{N} ._()+/-]/gu, '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, MAX_PART) : null;
}

/** Un client hint de texto («"SM-S918B"») sin comillas y limpio; vacío → null. */
export function hintString(value: string | null): string | null {
  return value ? clean(value.replace(/^"(.*)"$/, '$1')) : null;
}

/** «"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"» → «Chrome 130». */
export function browserFromBrands(secChUa: string | null): string | null {
  if (!secChUa) return null;
  const brands = [...secChUa.matchAll(/"([^"]+)"\s*;\s*v="(\d+)/g)].map((m) => ({ name: m[1]!, major: m[2]! }));
  const real = brands.filter((b) => !/not.?a.?brand/i.test(b.name));
  const named = real.find((b) => b.name !== 'Chromium') ?? real[0];
  return named ? clean(`${BRAND_NAMES[named.name] ?? named.name} ${named.major}`) : null;
}

/** El navegador del User-Agent («Safari 18»), o el de la app que lo lleva dentro. */
function browserFromUa(ua: string): string | null {
  for (const [re, name] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return null;
}

interface UaParts {
  model: string | null;
  os: string | null;
  osVersion: string | null;
  mobile: boolean | null;
}

function fromUa(ua: string): UaParts {
  const apple = /\((iPhone|iPad|iPod)[^)]*?OS (\d+)[_.]\d+/.exec(ua);
  if (apple) return { model: apple[1]!, os: 'iOS', osVersion: apple[2]!, mobile: apple[1] !== 'iPad' };
  const android = /Android (\d+)(?:[.\d]*)?(?:;\s*([^;)]+?))?(?:\s+Build\/[^;)]*)?\)/.exec(ua);
  if (android) {
    const model = android[2]?.trim() ?? null;
    // «Android 10; K»: el recortado de Chrome. Ni el modelo ni la versión son de verdad.
    const reduced = model === null || model === 'K';
    return { model: reduced ? null : clean(model), os: 'Android', osVersion: reduced ? null : android[1]!, mobile: /Mobile/.test(ua) };
  }
  if (/Windows NT/.test(ua)) return { model: null, os: 'Windows', osVersion: null, mobile: false };
  if (/CrOS/.test(ua)) return { model: null, os: 'ChromeOS', osVersion: null, mobile: false };
  // Un iPad en modo escritorio también se anuncia como Mac: sin modelo.
  if (/Macintosh|Mac OS X/.test(ua)) return { model: null, os: 'macOS', osVersion: null, mobile: false };
  if (/Linux/.test(ua)) return { model: null, os: 'Linux', osVersion: null, mobile: null };
  return { model: null, os: null, osVersion: null, mobile: null };
}

/**
 * El dispositivo por sus cabeceras: client hints si las manda (Android con
 * Chrome), si no, el User-Agent. Nunca lanza.
 */
export function describeClientDevice(headers: Headers): DeviceInfo {
  const ua = headerValue(headers, 'user-agent') ?? '';
  const parts = fromUa(ua);
  const platform = hintString(headerValue(headers, 'sec-ch-ua-platform'));
  const platformVersion = hintString(headerValue(headers, 'sec-ch-ua-platform-version'));
  const hintMajor = platformVersion ? (/^(\d+)/.exec(platformVersion)?.[1] ?? null) : null;
  const mobileHint = headerValue(headers, 'sec-ch-ua-mobile');
  const os = parts.os ?? platform;
  const inApp = IN_APP_BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  return {
    model: hintString(headerValue(headers, 'sec-ch-ua-model')) ?? parts.model,
    os,
    // La versión de Android, de los client hints (el User-Agent recortado la congela).
    osVersion: os === 'Android' && hintMajor && hintMajor !== '0' ? hintMajor : parts.osVersion,
    browser: browserFromUa(ua) ?? browserFromBrands(headerValue(headers, 'sec-ch-ua')),
    mobile: mobileHint === '?1' ? true : mobileHint === '?0' ? false : parts.mobile,
    inApp,
  };
}

/** Solo las cabeceras del dispositivo (para no guardar el resto en el contexto). */
export function deviceHeadersOf(headers: Headers | undefined): Headers {
  const out: Headers = {};
  if (!headers) return out;
  for (const name of DEVICE_HEADERS) {
    const v = headers[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** El dispositivo de una petición y su IP real (la misma que los límites de peticiones). */
export function requestDevice(req: ClientIpRequest): ClientDevice {
  return { ...describeClientDevice(req.headers), ip: clientIp(req) };
}
