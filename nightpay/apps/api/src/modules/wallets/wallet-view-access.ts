import { hasWalletViewSession } from './wallet-view-session';

interface ViewDependencies {
  walletRefByToken: (token: string) => Promise<{ id: string }>;
  hasPasskey: (walletId: string) => Promise<boolean>;
  secret: string;
}

/** El enlace privado permite la primera activación; con passkey se exige sesión de consulta. */
export async function mayReadWallet(deps: ViewDependencies, token: string, cookies: string | undefined): Promise<boolean> {
  const wallet = await deps.walletRefByToken(token);
  return !(await deps.hasPasskey(wallet.id)) || hasWalletViewSession(deps.secret, { id: wallet.id, qrToken: token }, cookies);
}
