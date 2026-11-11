import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
import type { PayLanguage } from '../payments/customer-lang';
import { HOME_TOPUP_DAY_S, HOME_TOPUP_DAY_START_UTC_S, homeTopUpDay } from './home-topup-rules';

/**
 * El QR de la cola (B16): un cartel en la entrada con un QR a /r para que
 * quien espera cargue su saldo antes de llegar al mostrador (en recepción
 * solo le dan la ficha). Dentro del local todos salen por la misma IP del
 * wifi, así que con este QR no vale el tope por IP de /r: en su lugar,
 *  - el QR es de un local y de una noche: lleva la noche (el «día» de /r, que
 *    cambia a las 10:00 UTC) y una firma del servidor atada al local y a su
 *    enlace de ahora (un enlace nuevo lo anula) y solo vale esa noche;
 *  - un tope por móvil (una cookie firmada que pone la página al abrirse con
 *    el QR): QUEUE_DEVICE_MAX cargas por noche;
 *  - un tope por local y noche: QUEUE_NIGHT_MAX cargas desde el cartel;
 *  - como mucho una carga sin pagar a la vez por móvil;
 *  - por IP y noche, holgados (toda la cola sale por el mismo wifi; solo para
 *    que un script no invente móviles): QUEUE_COOKIES_PER_IP_MAX móviles
 *    nuevos (cookies) y QUEUE_IP_NIGHT_MAX cargas desde el cartel;
 *  - y lo de siempre, pero con cuentas propias (clave `wcasa:cola:`): el freno
 *    del local cada 15 min y las que hay en curso a la vez, para que lo que
 *    pase en la cola no pare el enlace de siempre (/r); 3DS en el pago con
 *    tarjeta y cada carga en el registro (audit).
 * Sin la cookie del móvil (cookies bloqueadas) no se carga desde el cartel.
 */

/** ?cola=<noche>.<firma> en el enlace del cartel. */
export const QUEUE_PARAM = 'cola';
/** Cargas por móvil y noche desde el cartel (alguien que carga dos veces, sí; un script, no). */
export const QUEUE_DEVICE_MAX = 3;
/** Cargas desde el cartel por local y noche. */
export const QUEUE_NIGHT_MAX = 300;
/** La cookie del móvil (Path=/r: solo la ve esta página). */
export const QUEUE_DEVICE_COOKIE = 'np_cola';
/** Móviles nuevos (cookies del cartel) por IP y noche: pasado eso, la página no da cookie y lo dice. */
export const QUEUE_COOKIES_PER_IP_MAX = 20;
/** Cargas desde el cartel (POST /r/:code/cola) por IP y noche. */
export const QUEUE_IP_NIGHT_MAX = 40;
/** Cuánto se recuerda la carga sin pagar de un móvil (después, como mucho, la hora de «a medias»). */
export const QUEUE_OPEN_TTL_S = 60 * 60;
/** Mientras se crea (si el proceso se cae a medias, el hueco se libera solo). */
export const QUEUE_PENDING_TTL_S = 60;

const TOKEN_RE = /^([0-9]{1,6})\.([A-Za-z0-9_-]{22})$/;
const DEVICE_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const SIG_LENGTH = 22;

function sig(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('base64url').slice(0, SIG_LENGTH);
}

function sameSig(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** El QR del cartel de esta noche: la noche y su firma (local + su enlace de ahora). */
export function queueToken(secret: string, venueId: string, code: string, nowMs: number = Date.now()): string {
  const night = homeTopUpDay(nowMs);
  return `${night}.${sig(secret, `home-topup-queue:${venueId}:${code}:${night}`)}`;
}

/** ¿Es el QR del cartel de este local y de ESTA noche? (con el enlace de ahora; tiempo constante en la firma) */
export function queueTokenValid(
  secret: string,
  venueId: string,
  code: string,
  token: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (secret.length < 32 || typeof token !== 'string') return false;
  const m = TOKEN_RE.exec(token);
  if (!m) return false;
  const night = Number(m[1]);
  if (night !== homeTopUpDay(nowMs)) return false;
  return sameSig(m[2]!, sig(secret, `home-topup-queue:${venueId}:${code}:${night}`));
}

/** Hasta cuándo vale el cartel de esta noche (cuando cambia el «día» de /r, a las 10:00 UTC). */
export function queueValidUntil(nowMs: number = Date.now()): Date {
  const next = homeTopUpDay(nowMs) + 1;
  return new Date((next * HOME_TOPUP_DAY_S + HOME_TOPUP_DAY_START_UTC_S) * 1000);
}

/** El enlace del cartel: el de /r con su QR de la noche. */
export function queueUrl(homeTopUpUrl: string, token: string): string {
  return `${homeTopUpUrl}${homeTopUpUrl.includes('?') ? '&' : '?'}${QUEUE_PARAM}=${encodeURIComponent(token)}`;
}

// ─── El móvil ───────────────────────────────────────────────────────

/** Un móvil nuevo: un id al azar y su firma. */
export function newQueueDevice(secret: string): string {
  const id = randomBytes(16).toString('base64url');
  return `${id}.${sig(secret, `home-topup-queue-device:${id}`)}`;
}

/** El id del móvil de la cookie si la firma es buena (si no, null). */
export function queueDeviceId(secret: string, cookieHeader: string | undefined): string | null {
  const prefix = `${QUEUE_DEVICE_COOKIE}=`;
  const raw = (cookieHeader ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  if (!raw || secret.length < 32) return null;
  const m = DEVICE_RE.exec(raw.slice(prefix.length));
  if (!m) return null;
  return sameSig(m[2]!, sig(secret, `home-topup-queue-device:${m[1]!}`)) ? m[1]! : null;
}

/** La cookie del móvil (un día; HttpOnly; solo /r). */
export function queueDeviceCookie(value: string, secure: boolean): string {
  return `${QUEUE_DEVICE_COOKIE}=${value}; Path=/r; Max-Age=${HOME_TOPUP_DAY_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Las claves de los topes de esta noche: por móvil y por local. */
export function queueKeys(venueId: string, deviceId: string, nowMs: number = Date.now()): { device: string; night: string } {
  const night = homeTopUpDay(nowMs);
  return {
    device: `np:home-topup:queue-device:${venueId}:${deviceId}:${night}`,
    night: `np:home-topup:queue-night:${venueId}:${night}`,
  };
}

/** Cargas desde el cartel de esta IP esta noche (ipKey: rateLimitIpKey). */
export function queueIpKey(venueId: string, ipKey: string, nowMs: number = Date.now()): string {
  return `np:home-topup:queue-ip:${venueId}:${ipKey}:${homeTopUpDay(nowMs)}`;
}

/** Móviles nuevos (cookies) que el cartel de este enlace ha dado a esta IP esta noche. */
export function queueCookieKey(code: string, ipKey: string, nowMs: number = Date.now()): string {
  return `np:home-topup:queue-cookie:${code}:${ipKey}:${homeTopUpDay(nowMs)}`;
}

/** La carga sin pagar de este móvil (su id de cobro; «pending» mientras se crea). */
export function queueOpenKey(venueId: string, deviceId: string): string {
  return `np:home-topup:queue-open:${venueId}:${deviceId}`;
}

/**
 * El freno por IP de «Cargar» desde el cartel (POST /r/:code/cola): holgado,
 * porque toda la cola sale por el wifi del local; solo para que un script
 * desde una IP no lo llene. Los topes de verdad son por móvil y por noche.
 */
export const QUEUE_START_LIMIT: IpRateLimitConfig = Object.freeze({
  max: 200,
  windowSec: 15 * 60,
  scope: 'home-topup-queue',
  perKey: { param: 'code', max: 200 },
});

// ─── Textos ─────────────────────────────────────────────────────────

/** Encima de la carga, en la página abierta con el QR del cartel. */
export const QUEUE_PAGE_TEXT: Readonly<
  Record<PayLanguage, { note: string; expired: string; noCookies: string; deviceMax: string; nightMax: string; noDevice: string; ipMax: string; open: string }>
> = {
  es: {
    note: 'Carga tu saldo mientras esperas: en recepción solo te darán la ficha.',
    expired: 'Este QR era de otra noche. Escanea el del cartel de hoy o carga en recepción.',
    noCookies: 'Tu navegador no deja guardar la sesión de esta página. Ábrela otra vez desde el QR o carga en recepción.',
    deviceMax: 'Ya has cargado varias veces desde este móvil esta noche. Si necesitas más, pídelo en recepción.',
    nightMax: 'Esta noche ya no se puede cargar desde el cartel. Pídelo en recepción.',
    noDevice: 'Desde esta conexión ya se han abierto muchas cargas del cartel esta noche. Carga con los datos del móvil (sin el wifi) o en recepción.',
    ipMax: 'Desde esta conexión ya se ha cargado mucho desde el cartel esta noche. Carga con los datos del móvil (sin el wifi) o en recepción.',
    open: 'Ya tienes una carga sin pagar en este móvil: págala o espera unos minutos a que caduque.',
  },
  en: {
    note: 'Top up your balance while you wait: at reception they’ll just give you your tag.',
    expired: 'This QR was for another night. Scan today’s poster or top up at reception.',
    noCookies: 'Your browser won’t keep this page’s session. Open it again from the QR or top up at reception.',
    deviceMax: 'You’ve already topped up several times from this phone tonight. If you need more, ask at reception.',
    nightMax: 'Topping up from the poster is closed for tonight. Ask at reception.',
    noDevice: 'Many top-ups from the poster have already been opened on this connection tonight. Top up using mobile data (not the wifi) or at reception.',
    ipMax: 'A lot has already been topped up from the poster on this connection tonight. Top up using mobile data (not the wifi) or at reception.',
    open: 'You already have an unpaid top-up on this phone: pay it or wait a few minutes for it to expire.',
  },
  fr: {
    note: 'Rechargez votre solde pendant que vous attendez : à l’accueil, on vous donnera juste votre badge.',
    expired: 'Ce QR était pour une autre soirée. Scannez l’affiche du jour ou rechargez à l’accueil.',
    noCookies: 'Votre navigateur ne garde pas la session de cette page. Rouvrez-la depuis le QR ou rechargez à l’accueil.',
    deviceMax: 'Vous avez déjà rechargé plusieurs fois depuis ce téléphone ce soir. Pour plus, demandez à l’accueil.',
    nightMax: 'La recharge depuis l’affiche est fermée pour ce soir. Demandez à l’accueil.',
    noDevice: 'Beaucoup de recharges depuis l’affiche ont déjà été ouvertes sur cette connexion ce soir. Rechargez avec les données mobiles (sans le wifi) ou à l’accueil.',
    ipMax: 'Beaucoup de recharges ont déjà été faites depuis l’affiche sur cette connexion ce soir. Rechargez avec les données mobiles (sans le wifi) ou à l’accueil.',
    open: 'Vous avez déjà une recharge non payée sur ce téléphone : payez-la ou attendez quelques minutes qu’elle expire.',
  },
  pt: {
    note: 'Carregue o seu saldo enquanto espera: na receção só lhe dão a tag.',
    expired: 'Este QR era de outra noite. Leia o cartaz de hoje ou carregue na receção.',
    noCookies: 'O seu navegador não guarda a sessão desta página. Abra-a outra vez a partir do QR ou carregue na receção.',
    deviceMax: 'Já carregou várias vezes a partir deste telefone esta noite. Se precisar de mais, peça na receção.',
    nightMax: 'Esta noite já não se pode carregar a partir do cartaz. Peça na receção.',
    noDevice: 'Já se abriram muitos carregamentos do cartaz nesta ligação esta noite. Carregue com os dados móveis (sem o wifi) ou na receção.',
    ipMax: 'Já se carregou muito a partir do cartaz nesta ligação esta noite. Carregue com os dados móveis (sem o wifi) ou na receção.',
    open: 'Já tem um carregamento por pagar neste telefone: pague-o ou espere uns minutos até expirar.',
  },
};

