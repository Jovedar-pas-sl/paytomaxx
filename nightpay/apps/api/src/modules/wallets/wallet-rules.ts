import { randomBytes, randomInt } from 'node:crypto';

/**
 * Saldo NightPay del cliente (rediseño de la wallet). Reglas puras:
 *  - el código corto que enseña el cliente (en su móvil) para que la chica lo
 *    encuentre, sin listas de "Mesa 3";
 *  - cada gasto es un cobro con caducidad que paga el cliente (QR + Face ID, o
 *    su código / ficha + PIN);
 *  - el saldo vale en todos los locales del mismo grupo (mismo dueño).
 */

/** Sin letras que se confunden (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const WALLET_CODE_LENGTH = 6;

/** Código del cliente, p. ej. "K7Q4M2" (se enseña como "K7Q-4M2"). */
export function newWalletCode(): string {
  return Array.from({ length: WALLET_CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

/** Enlace del saldo (/w/<token>): 144 bits, la credencial del cliente. */
export function newWalletToken(): string {
  return randomBytes(18).toString('base64url');
}

/** Lo que teclea la chica ("k7q 4m2") → "K7Q4M2". */
export function normalizeWalletCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatWalletCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * La app de la chica. Con NEXT_PUBLIC_OPERATOR_URL, esa; si no, la del API
 * cambiando "api." por "operator." (como el QR de los cobros con datáfono).
 */
export function operatorBaseUrl(apiBase: string | undefined, operatorBase: string | undefined): string | null {
  const explicit = operatorBase?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const api = apiBase?.trim().replace(/\/+$/, '');
  if (!api || !/^https?:\/\/api\./i.test(api)) return null;
  return api.replace(/^(https?:\/\/)api\./i, '$1operator.');
}

/**
 * Lo que lleva el QR de la página del saldo: SOLO el código del cliente (el
 * enlace del saldo es su credencial y no sale nunca). Como enlace a la app de
 * la chica, para que también valga la cámara normal del móvil.
 */
export function walletCodeQrContent(code: string, operatorBase: string | null): string {
  const normalized = normalizeWalletCode(code);
  return operatorBase ? `${operatorBase}/?saldo=${normalized}` : normalized;
}

/**
 * ¿Se puede gastar en este local un saldo cargado en otro? Sí si es el mismo
 * local o si los dos están en el mismo grupo (mismo dueño, mismo comercio BBVA).
 */
export function sameWalletGroup(
  wallet: { tenantId: string; walletGroup: string | null },
  venue: { id: string; walletGroup: string | null },
): boolean {
  if (wallet.tenantId === venue.id) return true;
  return wallet.walletGroup !== null && wallet.walletGroup === venue.walletGroup;
}

export type ChargeRequestStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELED';

/** Estado efectivo: una pendiente pasada de tiempo cuenta como caducada. */
export function effectiveRequestStatus(r: { status: string; expiresAt: Date }, now: Date): ChargeRequestStatus {
  if (r.status === 'PENDING' && r.expiresAt <= now) return 'EXPIRED';
  return r.status as ChargeRequestStatus;
}

export type AcceptDecision =
  | { ok: true }
  | { ok: false; reason: 'not-pending' | 'expired' | 'wallet-closed' | 'insufficient' | 'blocked' };

/** ¿Se puede aceptar ahora este cobro con este saldo? (bloqueado por el super-admin: no paga) */
export function decideAccept(
  request: { status: string; expiresAt: Date; amountCents: number },
  wallet: { status: string; balanceCents: number; blockedAt?: Date | null },
  now: Date,
): AcceptDecision {
  const status = effectiveRequestStatus(request, now);
  if (status === 'EXPIRED') return { ok: false, reason: 'expired' };
  if (status !== 'PENDING') return { ok: false, reason: 'not-pending' };
  if (wallet.blockedAt) return { ok: false, reason: 'blocked' };
  if (wallet.status !== 'ACTIVE') return { ok: false, reason: 'wallet-closed' };
  if (wallet.balanceCents < request.amountCents) return { ok: false, reason: 'insufficient' };
  return { ok: true };
}

/** Cómo se devuelve el saldo al cliente que se va. */
export type WalletPayoutMethod = 'CARD' | 'CASH';

/**
 * Reparte una devolución a tarjeta entre las recargas pagadas (la más
 * reciente primero): cada trozo es una devolución en el portal del banco.
 */
export function allocateCardRefund(
  topUps: ReadonlyArray<{ paymentId: string; availableAmountCents: number }>,
  amountCents: number,
): Array<{ paymentId: string; amountCents: number }> {
  const out: Array<{ paymentId: string; amountCents: number }> = [];
  let remaining = amountCents;
  for (const t of topUps) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, t.availableAmountCents);
    if (take > 0) out.push({ paymentId: t.paymentId, amountCents: take });
    remaining -= take;
  }
  return remaining > 0 ? [] : out;
}
