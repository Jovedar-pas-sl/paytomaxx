import { describe, expect, it, vi } from 'vitest';
import {
  WALLET_VIEW_IDLE_S,
  WALLET_VIEW_MAX_S,
  WALLET_VIEW_RENEW_STEP_S,
  hasWalletViewSession,
  readWalletViewSession,
  renewWalletViewCookies,
  walletViewPaths,
  walletViewSetCookies,
} from './wallet-view-session';
import { walletViewAccess } from './wallet-view-access';

const secret = 'test-only-cookie-secret-at-least-32-characters';
const wallet = { id: 'wallet-a', qrToken: 'privateToken0123456789' };
const now = 1_800_000_000_000;
const valueOf = (s: string) => s.split(';')[0]!;
const first = (cookies: string[] | null) => valueOf(cookies![0]!);
const at = (seconds: number) => now + seconds * 1000;

describe('sesión de consulta del saldo', () => {
  it('solo sirve para el saldo firmado y su enlace actual', () => {
    const cookie = first(walletViewSetCookies(secret, wallet, now));
    expect(hasWalletViewSession(secret, wallet, cookie, now)).toBe(true);
    expect(readWalletViewSession(secret, wallet, cookie, now)).toEqual({ unlockedAt: now / 1000, expiresAt: now / 1000 + WALLET_VIEW_IDLE_S });
    expect(hasWalletViewSession(secret, { ...wallet, id: 'otro' }, cookie, now)).toBe(false);
    // Enlace regenerado: la sesión anterior ya no vale.
    expect(hasWalletViewSession(secret, { ...wallet, qrToken: 'enlace-nuevo' }, cookie, now)).toBe(false);
    expect(hasWalletViewSession(secret, wallet, cookie.slice(0, -1) + '!', now)).toBe(false);
    expect(hasWalletViewSession('another-secret-with-more-than-32-characters', wallet, cookie, now)).toBe(false);
    // Una cookie fechada en el futuro no la emite este servidor.
    expect(hasWalletViewSession(secret, wallet, cookie, now - 1000)).toBe(false);
  });

  it('sin actividad caduca a los 15 minutos', () => {
    const cookie = first(walletViewSetCookies(secret, wallet, now));
    expect(hasWalletViewSession(secret, wallet, cookie, at(WALLET_VIEW_IDLE_S - 1))).toBe(true);
    expect(hasWalletViewSession(secret, wallet, cookie, at(WALLET_VIEW_IDLE_S))).toBe(false);
  });

  it('con actividad se desliza (como mucho una reescritura por minuto) y nunca pasa de una hora', () => {
    let cookie = first(walletViewSetCookies(secret, wallet, now));
    // La página consulta cada 3 s: en el primer minuto no se reescribe.
    const fresh = readWalletViewSession(secret, wallet, cookie, at(3))!;
    expect(renewWalletViewCookies(secret, wallet, fresh, at(3))).toBeNull();
    expect(renewWalletViewCookies(secret, wallet, fresh, at(WALLET_VIEW_RENEW_STEP_S - 1))).toBeNull();
    // Mirando sin parar, cada minuto la alarga hasta 15 minutos por delante.
    for (let s = WALLET_VIEW_RENEW_STEP_S; s < WALLET_VIEW_MAX_S; s += WALLET_VIEW_RENEW_STEP_S) {
      const session = readWalletViewSession(secret, wallet, cookie, at(s));
      expect(session, `a los ${s} s`).not.toBeNull();
      const renewed = renewWalletViewCookies(secret, wallet, session!, at(s));
      if (renewed) cookie = first(renewed);
    }
    const last = readWalletViewSession(secret, wallet, cookie, at(WALLET_VIEW_MAX_S - 1))!;
    expect(last).toEqual({ unlockedAt: now / 1000, expiresAt: now / 1000 + WALLET_VIEW_MAX_S });
    // En el tope ya no se alarga más: a la hora, otra vez Face ID.
    expect(renewWalletViewCookies(secret, wallet, last, at(WALLET_VIEW_MAX_S - 1))).toBeNull();
    expect(hasWalletViewSession(secret, wallet, cookie, at(WALLET_VIEW_MAX_S))).toBe(false);
  });

  it('una renovación conserva la hora del desbloqueo y su Max-Age es lo que queda', () => {
    const cookie = first(walletViewSetCookies(secret, wallet, now));
    const session = readWalletViewSession(secret, wallet, cookie, at(600))!;
    const renewed = renewWalletViewCookies(secret, wallet, session, at(600))!;
    expect(renewed[0]).toContain(`Max-Age=${WALLET_VIEW_IDLE_S}`);
    expect(readWalletViewSession(secret, wallet, first(renewed), at(600))).toEqual({ unlockedAt: now / 1000, expiresAt: now / 1000 + 600 + WALLET_VIEW_IDLE_S });
    // Cerca del tope, la sesión llega justo a la hora y Max-Age es lo que falta.
    const nearCap = renewWalletViewCookies(secret, wallet, { unlockedAt: now / 1000, expiresAt: now / 1000 + 3000 }, at(3300))!;
    expect(nearCap[0]).toContain('Max-Age=300');
    expect(readWalletViewSession(secret, wallet, first(nearCap), at(3300))).toEqual({ unlockedAt: now / 1000, expiresAt: now / 1000 + WALLET_VIEW_MAX_S });
  });

  it('una cookie alterada para alargar más allá del tope no vale', () => {
    const cookie = first(walletViewSetCookies(secret, wallet, now));
    const [name, value] = cookie.split('=') as [string, string];
    const [unlocked, , nonce, sig] = value.split('.');
    for (const expiry of [now / 1000 + WALLET_VIEW_MAX_S + 60, now / 1000 + WALLET_VIEW_IDLE_S + 60]) {
      expect(hasWalletViewSession(secret, wallet, `${name}=${unlocked}.${expiry}.${nonce}.${sig}`, now)).toBe(false);
    }
  });

  it('HttpOnly, SameSite=Strict, sin Domain, Secure en producción y solo en las rutas de ese saldo', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const cookies = walletViewSetCookies(secret, wallet, now);
      expect(cookies).toHaveLength(2);
      expect(walletViewPaths(wallet.qrToken)).toEqual(['/w/privateToken0123456789', '/v1/wallets/public/privateToken0123456789']);
      cookies.forEach((cookie, i) => {
        expect(cookie).toContain(`; Path=${walletViewPaths(wallet.qrToken)[i]}; Max-Age=${WALLET_VIEW_IDLE_S}; HttpOnly; SameSite=Strict; Secure`);
        expect(cookie).not.toContain('Domain=');
        expect(cookie).not.toContain('Path=/;');
        expect(cookie).not.toContain(wallet.id);
      });
      // Las dos llevan el mismo valor: vale la que mande el navegador.
      expect(valueOf(cookies[0]!)).toBe(valueOf(cookies[1]!));
    } finally { vi.unstubAllEnvs(); }
  });

  it('rechaza secretos ausentes, cookies corruptas y firmas alteradas', () => {
    expect(() => walletViewSetCookies('', wallet)).toThrow();
    const c = first(walletViewSetCookies(secret, wallet, now));
    const parts = c.split('.');
    parts[2] = `${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`;
    expect(hasWalletViewSession(secret, wallet, parts.join('.'), now)).toBe(false);
    for (const cookies of [undefined, '', 'x=y', c + '.extra', c.replace(/=\d+/, '=garbage')]) {
      expect(hasWalletViewSession(secret, wallet, cookies, now)).toBe(false);
    }
    expect(hasWalletViewSession('corto', wallet, c, now)).toBe(false);
  });
});

describe('acceso a la consulta', () => {
  const deps = (passkey: boolean) => ({ walletRefByToken: async () => ({ id: wallet.id }), hasPasskey: async () => passkey, secret });

  it('sin passkey, el enlace privado basta (primera activación) y no hay nada que renovar', async () => {
    await expect(walletViewAccess(deps(false), wallet.qrToken, undefined, now)).resolves.toEqual({ allowed: true, renew: null });
  });

  it('con passkey hace falta la sesión; cada lectura con actividad la alarga', async () => {
    await expect(walletViewAccess(deps(true), wallet.qrToken, undefined, now)).resolves.toEqual({ allowed: false });
    const cookie = first(walletViewSetCookies(secret, wallet, now));
    await expect(walletViewAccess(deps(true), wallet.qrToken, cookie, at(10))).resolves.toEqual({ allowed: true, renew: null });
    const later = await walletViewAccess(deps(true), wallet.qrToken, cookie, at(5 * 60 + 1));
    expect(later.allowed).toBe(true);
    expect(later.allowed && later.renew).toHaveLength(2);
    await expect(walletViewAccess(deps(true), wallet.qrToken, cookie, at(WALLET_VIEW_IDLE_S))).resolves.toEqual({ allowed: false });
  });
});
