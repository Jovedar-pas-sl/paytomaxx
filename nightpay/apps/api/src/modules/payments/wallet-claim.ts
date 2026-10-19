import { createHmac } from 'node:crypto';

/** La cookie de "este navegador pagó" dura lo que una noche larga y algo más. */
export const WALLET_CLAIM_MAX_AGE_S = 7 * 24 * 3600;

/**
 * Nombre de la cookie que prueba que ESTE navegador hizo el pago de este
 * cobro. Su valor es aleatorio y propio de cada navegador; el intento de cobro
 * guarda su huella, y la página "Pagado" solo enseña el enlace del saldo al
 * navegador del intento que aprobó el banco (con ese enlace se aceptan
 * cobros: el personal que abra el mismo QR no debe verlo).
 */
export function walletClaimCookieName(secret: string, payToken: string): string {
  const mac = createHmac('sha256', secret).update(`wallet-claim:${payToken}`).digest('base64url');
  return `npw_${mac.slice(0, 22)}`;
}

/**
 * Set-Cookie de esa cookie. Path=/pay: también la recibe la vuelta del banco
 * (/pay/result). SameSite=None en producción: el banco devuelve al cliente
 * desde otro sitio.
 */
export function walletClaimSetCookie(secret: string, payToken: string, value: string): string {
  const site = process.env.NODE_ENV === 'production' ? 'Secure; SameSite=None' : 'SameSite=Lax';
  return `${walletClaimCookieName(secret, payToken)}=${value}; Path=/pay; Max-Age=${WALLET_CLAIM_MAX_AGE_S}; HttpOnly; ${site}`;
}
