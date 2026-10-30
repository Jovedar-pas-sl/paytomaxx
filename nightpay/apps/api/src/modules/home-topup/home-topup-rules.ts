import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HOME_TOPUP_CODE_RE, type HomeTopUpProblem } from '@nightpay/contracts';
import type { IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
import type { PayLanguage } from '../payments/customer-lang';
import type { TopUpVenueState } from '../wallets/wallet-topup-rules';

/**
 * «Cargar saldo antes de llegar»: reglas puras (las consultas, en
 * HomeTopUpService). Los importes, los mismos que «Recargar» en la página del
 * saldo (wallet-topup-rules.ts: euros enteros de 10 a 300 €); el tope de 24 h
 * de cada saldo cuenta también esta carga (WalletTopUpService). Además, un
 * freno contra abusos, como los límites que ya hay:
 *  - por IP: HOME_TOPUP_START_LIMIT (Redis, IpRateLimit): como mucho 6 cargas
 *    empezadas cada 15 min desde una IP en un local (perKey: el código del
 *    enlace) y 30 en todos;
 *  - por local: HOME_TOPUP_VENUE_MAX cargas empezadas cada 15 min (Redis; sin
 *    Redis no se carga: fail-closed, como «Recargar»);
 *  - y como mucho HOME_TOPUP_VENUE_MAX_UNRESOLVED a medias o sin respuesta del
 *    banco a la vez en el local (en la base): cada una que se queda en el
 *    banco acaba en Incidencias y hay que resolverla a mano.
 */

/** Idempotency-Key de la carga: `wcasa:<HMAC>`. Lleva «:», que la cabecera no admite: el personal no la puede fabricar. */
export const HOME_TOPUP_KEY_PREFIX = 'wcasa:';
const HOME_TOPUP_KEY_RE = /^wcasa:[0-9a-f]{64}$/;

/** Cargas empezadas en todo el local cada HOME_TOPUP_VENUE_WINDOW_S (un local grande no llega ni en su mejor noche). */
export const HOME_TOPUP_VENUE_MAX = 60;
export const HOME_TOPUP_VENUE_WINDOW_S = 15 * 60;
/** A medias (pago abierto o en el banco sin respuesta) a la vez en el local. */
export const HOME_TOPUP_VENUE_MAX_UNRESOLVED = 20;
export const HOME_TOPUP_UNRESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** El freno por IP de «Cargar» (POST /r/:code/topup). */
export const HOME_TOPUP_START_LIMIT: IpRateLimitConfig = Object.freeze({
  max: 30,
  windowSec: 15 * 60,
  scope: 'home-topup',
  perKey: { param: 'code', max: 6 },
});

/** La página del enlace (GET): holgado, como la del saldo; sin Redis se ve igual. */
export const HOME_TOPUP_PAGE_LIMIT: IpRateLimitConfig = Object.freeze({
  max: 120,
  windowSec: 60,
  scope: 'home-topup-page',
  failOpen: true,
});

// ─── El código del enlace ───────────────────────────────────────────

/** 12 bytes al azar (96 bits) en base64url: 16 letras, sin el id del local ni nada que se recorra. */
export function newHomeTopUpCode(): string {
  return randomBytes(12).toString('base64url');
}

export function isHomeTopUpCode(value: unknown): value is string {
  return typeof value === 'string' && HOME_TOPUP_CODE_RE.test(value);
}

/** Por qué el local, con el enlace encendido, no deja cargar ahora (null: deja). */
export function homeTopUpProblem(venue: TopUpVenueState): HomeTopUpProblem | null {
  if (venue.paused) return 'paused';
  if (!venue.card || !venue.wallet) return 'methods';
  if (!venue.hasGateway) return 'gateway';
  if (!venue.hasTerminal) return 'terminal';
  return null;
}

// ─── La carga ───────────────────────────────────────────────────────

/**
 * La Idempotency-Key de la carga sale de la clave del navegador (un doble
 * toque repite la misma) y del local, firmada con el secreto del servidor.
 */
export function homeTopUpKey(secret: string, venueId: string, clientKey: string): string {
  const mac = createHmac('sha256', secret).update(`home-topup:${venueId}:${clientKey}`).digest('hex');
  return `${HOME_TOPUP_KEY_PREFIX}${mac}`;
}

/** ¿Es la carga de un saldo nuevo desde el enlace del local? */
export function isHomeTopUpKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && HOME_TOPUP_KEY_RE.test(key);
}

/**
 * Tras pagar, el navegador que pagó va a su saldo nuevo (/w) con la
 * bienvenida: el «Pagado», su código, el QR de la ficha, activar Face ID o
 * el PIN y Google Wallet. `nuevo` es el cobro (solo enseña ese «Pagado»).
 */
export function walletWelcomeHref(walletToken: string, payToken: string, lang: PayLanguage): string {
  return `/w/${encodeURIComponent(walletToken)}?lang=${lang}&nuevo=${encodeURIComponent(payToken)}`;
}

// ─── «Ya tienes un saldo aquí» ──────────────────────────────────────

/**
 * Este navegador recuerda sus saldos en una cookie propia (Path=/r: solo la
 * ve esta página), con el id de cada saldo y su firma: nunca el enlace del
 * saldo (es su credencial). La pone la página del saldo (/w) al abrirse. Con
 * ella, el enlace del local ofrece recargar ese saldo en vez de crear otro.
 */
export const REMEMBER_COOKIE = 'np_saldos';
export const REMEMBER_PATH = '/r';
export const REMEMBER_MAX_AGE_S = 180 * 24 * 3600;
export const REMEMBER_MAX_WALLETS = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIG_LENGTH = 22;

function rememberSig(secret: string, walletId: string): string {
  return createHmac('sha256', secret).update(`home-topup-remember:${walletId}`).digest('base64url').slice(0, SIG_LENGTH);
}

function sameSig(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Los saldos que recuerda este navegador (solo los de firma buena), del más reciente al más viejo. */
export function rememberedWalletIds(cookieHeader: string | undefined, secret: string): string[] {
  if (!secret) return [];
  const prefix = `${REMEMBER_COOKIE}=`;
  const raw = (cookieHeader ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!raw) return [];
  const ids: string[] = [];
  for (const entry of raw.slice(prefix.length).split('~').slice(0, REMEMBER_MAX_WALLETS)) {
    const [id = '', sig = ''] = entry.split('.');
    if (UUID_RE.test(id) && sameSig(sig, rememberSig(secret, id)) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Set-Cookie que añade este saldo (el primero) a los que recuerda el navegador. */
export function rememberSetCookie(secret: string, walletId: string, cookieHeader: string | undefined): string | null {
  if (!secret || !UUID_RE.test(walletId)) return null;
  const ids = [walletId, ...rememberedWalletIds(cookieHeader, secret).filter((id) => id !== walletId)].slice(0, REMEMBER_MAX_WALLETS);
  const value = ids.map((id) => `${id}.${rememberSig(secret, id)}`).join('~');
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${REMEMBER_COOKIE}=${value}; Path=${REMEMBER_PATH}; Max-Age=${REMEMBER_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`;
}
