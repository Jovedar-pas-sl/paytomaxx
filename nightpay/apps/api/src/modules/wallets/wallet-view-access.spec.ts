import { describe, expect, it } from 'vitest';
import { WALLET_VIEW_IDLE_S, WALLET_VIEW_MAX_S, walletViewSetCookies } from './wallet-view-session';
import { walletStreamAccess } from './wallet-view-access';

/**
 * La conexión de avisos de la página del saldo (GET /w/:token/events): la
 * misma regla que /state, y además de qué saldo es y hasta cuándo vale la
 * sesión (la conexión se cierra entonces: la página vuelve a entrar con su
 * cookie o, si ya no vale, al desbloqueo).
 */
const secret = 'test-only-cookie-secret-at-least-32-characters';
const wallet = { id: 'wallet-a', qrToken: 'privateToken0123456789' };
const now = 1_800_000_000_000;
const at = (seconds: number) => now + seconds * 1000;
const cookieOf = (cookies: string[]) => cookies[0]!.split(';')[0]!;
const deps = (passkey: boolean) => ({ walletRefByToken: async () => ({ id: wallet.id }), hasPasskey: async () => passkey, secret });

describe('acceso a los avisos de la página del saldo', () => {
  it('sin passkey: el enlace basta, sin hora de caducidad (manda el tope de vida de la conexión)', async () => {
    await expect(walletStreamAccess(deps(false), wallet.qrToken, undefined, now)).resolves.toEqual({
      allowed: true,
      walletId: wallet.id,
      renew: null,
      expiresAt: null,
    });
  });

  it('con passkey y sin sesión: no', async () => {
    await expect(walletStreamAccess(deps(true), wallet.qrToken, undefined, now)).resolves.toEqual({ allowed: false });
  });

  it('con sesión: hasta cuándo vale la que tiene (sin renovar en el primer minuto)', async () => {
    const cookie = cookieOf(walletViewSetCookies(secret, wallet, now));
    await expect(walletStreamAccess(deps(true), wallet.qrToken, cookie, at(10))).resolves.toEqual({
      allowed: true,
      walletId: wallet.id,
      renew: null,
      expiresAt: now / 1000 + WALLET_VIEW_IDLE_S,
    });
  });

  it('abrirla es actividad: la sesión se alarga y la hora es la nueva (nunca más allá de la hora del desbloqueo)', async () => {
    const cookie = cookieOf(walletViewSetCookies(secret, wallet, now));
    const later = await walletStreamAccess(deps(true), wallet.qrToken, cookie, at(5 * 60 + 1));
    expect(later.allowed && later.renew).toHaveLength(2);
    expect(later.allowed && later.expiresAt).toBe(now / 1000 + 5 * 60 + 1 + WALLET_VIEW_IDLE_S);
    // Cerca del tope de una hora: la hora del tope.
    let c = cookie;
    for (let s = 60; s < WALLET_VIEW_MAX_S - 120; s += 60) {
      const a = await walletStreamAccess(deps(true), wallet.qrToken, c, at(s));
      if (a.allowed && a.renew) c = cookieOf(a.renew);
    }
    const end = await walletStreamAccess(deps(true), wallet.qrToken, c, at(WALLET_VIEW_MAX_S - 60));
    expect(end.allowed && end.expiresAt).toBe(now / 1000 + WALLET_VIEW_MAX_S);
  });
});
