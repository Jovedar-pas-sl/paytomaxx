import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sesión de consulta tras verificar la passkey del saldo; no autoriza pagos ni
 * cambios. Deslizante: cada consulta de la página (la refresca cada 3 s
 * mientras se ve) la alarga hasta WALLET_VIEW_IDLE_S sin actividad, y nunca
 * más allá de WALLET_VIEW_MAX_S desde que se desbloqueó; después, otra vez
 * Face ID.
 *
 * Valor: <desbloqueo>.<caduca>.<nonce>.<firma>; la firma ata el saldo y su
 * enlace actual (un enlace nuevo la invalida). HttpOnly, SameSite=Strict, sin
 * Domain y solo en las rutas de ese saldo: /w/<enlace> (página, estado y
 * Google Wallet) y /v1/wallets/public/<enlace> (la ruta JSON antigua).
 */
export const WALLET_VIEW_IDLE_S = 15 * 60;
export const WALLET_VIEW_MAX_S = 60 * 60;
/** La página consulta cada 3 s: la cookie se reescribe como mucho una vez por minuto. */
export const WALLET_VIEW_RENEW_STEP_S = 60;

export interface WalletRef {
  id: string;
  qrToken: string;
}

export interface WalletViewSession {
  /** Segundos Unix del desbloqueo con la passkey. */
  unlockedAt: number;
  /** Segundos Unix en los que caduca si no hay más consultas. */
  expiresAt: number;
}

const VALUE_RE = /^\d{10}\.\d{10}\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/;

const cookieName = (secret: string, walletId: string): string =>
  `npwv_${createHmac('sha256', secret).update(`name:${walletId}`).digest('base64url').slice(0, 22)}`;
const mac = (secret: string, wallet: WalletRef, value: string): string =>
  createHmac('sha256', secret).update(`wallet-view:${wallet.id}:${wallet.qrToken}:${value}`).digest('base64url');
const seconds = (ms: number): number => Math.floor(ms / 1000);

/** Las rutas que leen el saldo con esta sesión (cada una lleva su cookie). */
export function walletViewPaths(qrToken: string): string[] {
  const token = encodeURIComponent(qrToken);
  return [`/w/${token}`, `/v1/wallets/public/${token}`];
}

function setCookies(secret: string, wallet: WalletRef, session: WalletViewSession, nowS: number): string[] {
  const value = `${session.unlockedAt}.${session.expiresAt}.${randomBytes(18).toString('base64url')}`;
  const secure = ['development', 'test'].includes(process.env.NODE_ENV ?? '') ? '' : '; Secure';
  const maxAge = Math.max(0, session.expiresAt - nowS);
  const signed = `${cookieName(secret, wallet.id)}=${value}.${mac(secret, wallet, value)}`;
  return walletViewPaths(wallet.qrToken).map((path) => `${signed}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`);
}

/** Tras verificar la passkey: sesión nueva (la hora máxima se cuenta desde ahora). */
export function walletViewSetCookies(secret: string, wallet: WalletRef, now = Date.now()): string[] {
  if (secret.length < 32) throw new Error('COOKIE_SECRET required for wallet view sessions');
  const nowS = seconds(now);
  return setCookies(secret, wallet, { unlockedAt: nowS, expiresAt: nowS + WALLET_VIEW_IDLE_S }, nowS);
}

/** La sesión válida de este saldo (y de su enlace actual) en estas cookies, o null. */
export function readWalletViewSession(secret: string, wallet: WalletRef, cookies: string | undefined, now = Date.now()): WalletViewSession | null {
  if (secret.length < 32 || !cookies) return null;
  const prefix = `${cookieName(secret, wallet.id)}=`;
  const value = cookies.split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix))?.slice(prefix.length);
  if (!value || !VALUE_RE.test(value)) return null;
  const [unlocked, expiry, nonce, signature] = value.split('.') as [string, string, string, string];
  const nowS = seconds(now);
  const unlockedAt = Number(unlocked);
  const expiresAt = Number(expiry);
  if (unlockedAt > nowS || expiresAt <= nowS) return null;
  if (expiresAt - nowS > WALLET_VIEW_IDLE_S || expiresAt > unlockedAt + WALLET_VIEW_MAX_S) return null;
  const expected = mac(secret, wallet, `${unlocked}.${expiry}.${nonce}`);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? { unlockedAt, expiresAt } : null;
}

export function hasWalletViewSession(secret: string, wallet: WalletRef, cookies: string | undefined, now = Date.now()): boolean {
  return readWalletViewSession(secret, wallet, cookies, now) !== null;
}

/**
 * Hubo actividad: la sesión se alarga, sin pasar del máximo. null si no hace
 * falta reescribirla (se alargó hace menos de un minuto o ya está en el tope).
 */
export function renewWalletViewCookies(secret: string, wallet: WalletRef, session: WalletViewSession, now = Date.now()): string[] | null {
  const nowS = seconds(now);
  const expiresAt = Math.min(nowS + WALLET_VIEW_IDLE_S, session.unlockedAt + WALLET_VIEW_MAX_S);
  if (expiresAt - session.expiresAt < WALLET_VIEW_RENEW_STEP_S) return null;
  return setCookies(secret, wallet, { unlockedAt: session.unlockedAt, expiresAt }, nowS);
}
