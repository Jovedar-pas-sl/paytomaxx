import { sameWalletGroup } from '../../wallets/wallet-rules';

/**
 * ¿Llega esta clave a este saldo? El mismo grupo que comprueba el personal
 * del local (sameWalletGroup) **y** el local de origen del saldo (donde se
 * creó) con sociedad, la misma que la del local de la clave. Pura: la usan
 * también la página del saldo (WalletLiveCodeService.offered) y el PR 8. Aparte
 * de partner-wallet-ref.ts, que importa WalletLiveCodeService: sin ciclo.
 */
export function walletReachable(
  wallet: { tenantId: string; walletGroup: string | null },
  home: { businessId: string | null },
  conn: { tenantId: string; walletGroup: string | null; businessId: string | null },
): boolean {
  return (
    sameWalletGroup(wallet, { id: conn.tenantId, walletGroup: conn.walletGroup }) &&
    home.businessId !== null &&
    home.businessId === conn.businessId
  );
}
