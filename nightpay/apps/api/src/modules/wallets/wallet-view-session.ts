import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Consulta breve tras verificar una passkey; no autoriza pagos ni cambios. */
export const WALLET_VIEW_TTL_S = 5 * 60;
const cookieName = (secret: string, walletId: string): string =>
  `npwv_${createHmac('sha256', secret).update(`name:${walletId}`).digest('base64url').slice(0, 22)}`;
const mac = (secret: string, wallet: { id: string; qrToken: string }, value: string): string =>
  createHmac('sha256', secret).update(`wallet-view:${wallet.id}:${wallet.qrToken}:${value}`).digest('base64url');

export function walletViewSetCookie(secret: string, wallet: { id: string; qrToken: string }, now = Date.now()): string {
  if (secret.length < 32) throw new Error('COOKIE_SECRET required for wallet view sessions');
  const value = `${Math.floor(now / 1000) + WALLET_VIEW_TTL_S}.${randomBytes(18).toString('base64url')}`;
  const secure = ['development', 'test'].includes(process.env.NODE_ENV ?? '') ? '' : '; Secure';
  // Both /w/:token and the compatible /v1/wallets/public/:token endpoint need it.
  // Host-only; the signature still binds it to one wallet and its current token.
  return `${cookieName(secret, wallet.id)}=${value}.${mac(secret, wallet, value)}; Path=/; Max-Age=${WALLET_VIEW_TTL_S}; HttpOnly; SameSite=Strict${secure}`;
}

export function hasWalletViewSession(secret: string, wallet: { id: string; qrToken: string }, cookies: string | undefined, now = Date.now()): boolean {
  if (secret.length < 32 || !cookies) return false;
  const prefix = `${cookieName(secret, wallet.id)}=`;
  const value = cookies.split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix))?.slice(prefix.length);
  if (!value || !/^\d{10}\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [expiry, nonce, signature] = value.split('.');
  const left = Number(expiry) - Math.floor(now / 1000);
  if (left <= 0 || left > WALLET_VIEW_TTL_S) return false;
  const expected = mac(secret, wallet, `${expiry}.${nonce}`);
  return timingSafeEqual(Buffer.from(signature!), Buffer.from(expected));
}
