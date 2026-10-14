/**
 * Ficha NFC del saldo (NTAG213/215/216). Lleva grabado un enlace a la app de
 * cobro con un código al azar: https://operator.../?ficha=<token>. En Android
 * la app lo lee al acercarla; en iPhone el propio móvil abre el enlace.
 * La ficha solo dice de qué saldo es: para pagar, el cliente pone su PIN.
 */

/** El parámetro del enlace grabado en la ficha. */
export const WALLET_CARD_PARAM = 'ficha';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** ¿Es un código de ficha válido? */
export function isWalletCardToken(value: string): boolean {
  return TOKEN.test(value);
}

/** El código de la ficha a partir del enlace grabado (null si no es nuestra). */
export function walletCardTokenFromUrl(url: string): string | null {
  try {
    const token = new URL(url.trim()).searchParams.get(WALLET_CARD_PARAM) ?? '';
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** El enlace que se graba en la ficha. */
export function walletCardUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/?${WALLET_CARD_PARAM}=${token}`;
}

/** Número de serie de la ficha ("04:a2:3b:…") en mayúsculas y sin separadores. */
export function normalizeWalletCardUid(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length >= 8 && hex.length <= 32 ? hex : null;
}
