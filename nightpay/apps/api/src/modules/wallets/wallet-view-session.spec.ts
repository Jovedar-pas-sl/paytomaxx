import { describe, expect, it, vi } from 'vitest';
import { hasWalletViewSession, WALLET_VIEW_TTL_S, walletViewSetCookie } from './wallet-view-session';
const secret = 'test-only-cookie-secret-at-least-32-characters';
const wallet = { id: 'wallet-a', qrToken: 'privateToken0123456789' };
const now = 1_800_000_000_000;
const valueOf = (s: string) => s.split(';')[0]!;

describe('sesión breve de consulta', () => {
  it('solo sirve para el saldo firmado y caduca a los cinco minutos', () => {
    const cookie = walletViewSetCookie(secret, wallet, now);
    expect(hasWalletViewSession(secret, wallet, valueOf(cookie), now)).toBe(true);
    expect(hasWalletViewSession(secret, { ...wallet, id: 'otro' }, valueOf(cookie), now)).toBe(false);
    expect(hasWalletViewSession(secret, { ...wallet, qrToken: 'enlace-nuevo' }, valueOf(cookie), now)).toBe(false);
    expect(hasWalletViewSession(secret, wallet, valueOf(cookie), now + WALLET_VIEW_TTL_S * 1000)).toBe(false);
    expect(hasWalletViewSession(secret, wallet, valueOf(cookie), now - 1000)).toBe(false);
    expect(hasWalletViewSession(secret, wallet, valueOf(cookie).slice(0, -1) + '!', now)).toBe(false);
    expect(hasWalletViewSession('another-secret-with-more-than-32-characters', wallet, valueOf(cookie), now)).toBe(false);
  });
  it('HttpOnly, disponible en ambas rutas del mismo host y Secure en producción', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const cookie = walletViewSetCookie(secret, wallet, now);
      expect(cookie).toContain('HttpOnly; SameSite=Strict; Secure');
      expect(cookie).toContain('Path=/; Max-Age=300');
      expect(cookie).not.toContain('Domain=');
      expect(cookie).not.toContain(wallet.id);
    } finally { vi.unstubAllEnvs(); }
  });
  it('rechaza secretos ausentes, cookies corruptas y firmas alteradas', () => {
    expect(() => walletViewSetCookie('', wallet)).toThrow();
    const c = valueOf(walletViewSetCookie(secret, wallet, now));
    const parts = c.split('.');
    parts[1] = `${parts[1]![0] === 'A' ? 'B' : 'A'}${parts[1]!.slice(1)}`;
    expect(hasWalletViewSession(secret, wallet, parts.join('.'), now)).toBe(false);
    for (const cookies of [undefined, '', 'x=y', c + '.extra', c.replace(/=\d+/, '=garbage')]) {
      expect(hasWalletViewSession(secret, wallet, cookies, now)).toBe(false);
    }
  });
});
