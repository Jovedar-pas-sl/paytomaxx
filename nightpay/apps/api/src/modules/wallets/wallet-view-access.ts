import { readWalletViewSession, renewWalletViewCookies, renewedWalletViewExpiry } from './wallet-view-session';

interface ViewDependencies {
  walletRefByToken: (token: string) => Promise<{ id: string }>;
  hasPasskey: (walletId: string) => Promise<boolean>;
  secret: string;
}

/** Se puede leer el saldo; `renew`: las cookies que alargan la sesión (null: no hace falta). */
export type WalletViewAccess = { allowed: false } | { allowed: true; renew: string[] | null };

/**
 * Lo mismo, para la conexión de avisos de la página (GET /w/:token/events):
 * de qué saldo es y hasta cuándo vale su sesión (segundos Unix; null sin
 * passkey, que no tiene sesión: manda el tope de vida de la conexión).
 */
export type WalletStreamAccess =
  | { allowed: false }
  | { allowed: true; walletId: string; renew: string[] | null; expiresAt: number | null };

/**
 * Sin passkey, el enlace privado deja ver el saldo (no hay llave con la que
 * desbloquearlo), pero ya no activarlo: el primer Face ID o PIN va con el QR
 * de activación de un solo uso (M-2). Con passkey se exige sesión de
 * consulta, que cada lectura alarga (wallet-view-session.ts).
 */
export async function walletViewAccess(deps: ViewDependencies, token: string, cookies: string | undefined, now = Date.now()): Promise<WalletViewAccess> {
  const access = await walletStreamAccess(deps, token, cookies, now);
  return access.allowed ? { allowed: true, renew: access.renew } : { allowed: false };
}

export async function walletStreamAccess(deps: ViewDependencies, token: string, cookies: string | undefined, now = Date.now()): Promise<WalletStreamAccess> {
  const wallet = await deps.walletRefByToken(token);
  if (!(await deps.hasPasskey(wallet.id))) return { allowed: true, walletId: wallet.id, renew: null, expiresAt: null };
  const ref = { id: wallet.id, qrToken: token };
  const session = readWalletViewSession(deps.secret, ref, cookies, now);
  if (!session) return { allowed: false };
  return {
    allowed: true,
    walletId: wallet.id,
    renew: renewWalletViewCookies(deps.secret, ref, session, now),
    expiresAt: renewedWalletViewExpiry(session, now) ?? session.expiresAt,
  };
}

export async function mayReadWallet(deps: ViewDependencies, token: string, cookies: string | undefined): Promise<boolean> {
  return (await walletViewAccess(deps, token, cookies)).allowed;
}
