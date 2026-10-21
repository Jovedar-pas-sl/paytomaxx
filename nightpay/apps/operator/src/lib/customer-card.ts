import { isWalletCardToken } from '@nightpay/contracts';

/** El NFC de un cliente sin sesión abre la consulta; el del personal mantiene el cobro actual. */
export function customerCardDestination(card: string | null, signedIn: boolean, apiBase: string): string | null {
  if (signedIn || !card || !isWalletCardToken(card)) return null;
  return `${apiBase.replace(/\/+$/, '')}/w/card/${encodeURIComponent(card)}`;
}
