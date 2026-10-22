import { readWalletViewSession, renewWalletViewCookies } from './wallet-view-session';

interface ViewDependencies {
  walletRefByToken: (token: string) => Promise<{ id: string }>;
  hasPasskey: (walletId: string) => Promise<boolean>;
  secret: string;
}

/** Se puede leer el saldo; `renew`: las cookies que alargan la sesión (null: no hace falta). */
export type WalletViewAccess = { allowed: false } | { allowed: true; renew: string[] | null };

/**
 * El enlace privado permite la primera activación; con passkey se exige
 * sesión de consulta, que cada lectura alarga (wallet-view-session.ts).
 */
export async function walletViewAccess(deps: ViewDependencies, token: string, cookies: string | undefined, now = Date.now()): Promise<WalletViewAccess> {
  const wallet = await deps.walletRefByToken(token);
  if (!(await deps.hasPasskey(wallet.id))) return { allowed: true, renew: null };
  const ref = { id: wallet.id, qrToken: token };
  const session = readWalletViewSession(deps.secret, ref, cookies, now);
  if (!session) return { allowed: false };
  return { allowed: true, renew: renewWalletViewCookies(deps.secret, ref, session, now) };
}

export async function mayReadWallet(deps: ViewDependencies, token: string, cookies: string | undefined): Promise<boolean> {
  return (await walletViewAccess(deps, token, cookies)).allowed;
}
