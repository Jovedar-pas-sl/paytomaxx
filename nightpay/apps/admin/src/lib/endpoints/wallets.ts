// Saldos de clientes (Phase 1B).

import { STEP_UP_TOKEN_HEADER, type WalletByPhone } from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';
import type { WalletPayoutPreview, WalletPayoutResult } from '../wallet-payout';

// ─── Phase 1B — Wallets ─────────────────────────────────────────────

export interface WalletAdminRow {
  id: string;
  /** Código que el cliente ve en su página de saldo (K7Q-4M2). */
  code: string | null;
  /** El cliente pulsó "Me voy: devolver mi saldo". */
  closeRequestedAt: string | null;
  identifier: string | null;
  balanceCents: number;
  status: 'ACTIVE' | 'EXPIRED' | 'REFUNDED' | 'DEPLETED';
  expiresAt: string | null;
  consumptionCount: number;
  createdAt: string;
  /** El cliente activó Face ID (paga escaneando el QR de la chica). */
  hasFaceId: boolean;
  /** Puede pagar sin sacar el móvil, con su PIN. */
  hasPin: boolean;
  /** 5 PIN fallidos: no puede pagar con PIN hasta que lo desbloquees. */
  pinLocked: boolean;
  /** Tiene ficha NFC activa. */
  hasCard: boolean;
}

/** Cobro con QR que la chica hizo y nadie ha pagado aún. */
export interface PendingQrCharge {
  id: string;
  amountCents: number;
  serviceName: string | null;
  requestedByName: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Encargado o dueño: el saldo de quien lo ha perdido todo (la ficha y el
 * código), por el teléfono que dejó al darle la ficha. Sin el teléfono.
 */
export async function findWalletsByPhone(phone: string): Promise<WalletByPhone[]> {
  const res = await authedFetch(`/v1/reception/wallets/by-phone?phone=${encodeURIComponent(phone)}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Encargado o dueño: cobros con QR sin pagar (cliente sin batería…). */
export async function fetchPendingQrCharges(): Promise<PendingQrCharge[]> {
  const res = await authedFetch('/v1/wallet-charges/pending-qr');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Encargado o dueño: cobrar ese cobro de este saldo, sin Face ID (queda registrado). */
export async function approveQrCharge(requestId: string, walletId: string, totpCode: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/${encodeURIComponent(requestId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ walletId, totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
}

/** Encargado o dueño: tras 5 PIN fallidos, el cliente vuelve a poder probar. */
export async function unlockWalletPin(walletId: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/pin/unlock`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
}

/** Encargado o dueño: ficha NFC perdida → bloqueada (el saldo sigue con Face ID o código + PIN). */
export async function blockWalletCard(walletId: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/card/block`, { method: 'POST' });
  if (!res.ok) throw await apiError(res);
}

/** Encargado o dueño, con su 2FA: el cliente olvidó su PIN → se borra y elige otro. */
export async function resetWalletPin(walletId: string, totpCode: string): Promise<void> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/pin/reset`, {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
}

export interface WalletsAdminStats {
  activeCount: number;
  totalBalanceCents: number;
  todayTopUpsCents: number;
  todayConsumptionsCents: number;
  todayRefundsCents: number;
  byCategory: Record<string, number>;
}

export async function fetchWalletsStats(): Promise<WalletsAdminStats> {
  const res = await authedFetch('/v1/admin/wallets/stats');
  if (!res.ok) throw new Error('Error cargando las cifras de los saldos');
  return res.json();
}

export async function fetchWalletsList(params?: {
  status?: WalletAdminRow['status'];
  limit?: number;
}): Promise<WalletAdminRow[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.limit) qs.set('limit', String(params.limit));
  const res = await authedFetch(`/v1/admin/wallets?${qs.toString()}`);
  if (!res.ok) throw new Error('Error cargando los saldos');
  return res.json();
}

/** Saldo de un cliente por su código (vale el de cualquier local del grupo). */
export interface WalletLookup {
  walletId: string;
  code: string;
  balanceCents: number;
  label: string | null;
  homeVenueName: string;
  /** El saldo se cargó en este local (la devolución a la tarjeta solo desde aquí). */
  isHomeVenue: boolean;
  /** El cliente pulsó "Me voy". */
  closeRequested: boolean;
  pendingRequest: boolean;
}

export async function lookupWalletCode(code: string): Promise<WalletLookup> {
  const res = await authedFetch(`/v1/wallet-charges/lookup/${encodeURIComponent(code)}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * El cliente perdió el enlace de su saldo: uno nuevo (solo el dueño). El viejo
 * deja de valer. Devuelve el enlace y su QR para que el cliente lo escanee.
 */
export async function relinkWallet(walletId: string, totpCode: string): Promise<{ url: string; qrDataUrl: string }> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/relink`, {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

export type WalletPayoutMethod = 'CARD' | 'CASH';
export type { WalletPayoutPreview };

/**
 * Antes de confirmar «Devolver saldo»: lo que el API devolvería ahora en
 * efectivo y a la tarjeta (no el saldo entero) y lo que hoy no puede salir.
 */
export async function fetchPayoutPreview(walletId: string): Promise<WalletPayoutPreview> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/payout-preview`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Devolver el saldo al cliente que se va. Efectivo: se lo das ahora (el
 * encargado, desde el umbral del local, con su código 2FA: 403 TOTP_REQUIRED).
 * Tarjeta (solo el dueño): primero se devuelve en el portal de BBVA y aquí se
 * apunta, repartido entre sus recargas. expectedAmountCents: la cifra que se
 * enseñó; si el API ya apuntaría otra, 409 PAYOUT_AMOUNT_CHANGED.
 */
export async function payoutWallet(
  walletId: string,
  input: {
    method: WalletPayoutMethod;
    bankReference?: string;
    note?: string;
    totpCode?: string;
    expectedAmountCents?: number;
  },
): Promise<WalletPayoutResult> {
  const res = await authedFetch(`/v1/wallet-charges/wallets/${encodeURIComponent(walletId)}/payout`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ─── Recargas en efectivo recientes (recepción) ─────────────────────

/** Una recarga en efectivo de este local que aún se puede anular (las 2 últimas horas). */
export interface RecentCashTopUp {
  id: string;
  at: string;
  amountCents: number;
  /** Su «Comisión del servicio» (al anularla, sale de la caja con el saldo). Un API de antes no la manda. */
  serviceFeeCents?: number;
  /** K7Q-•••: para reconocer al cliente. */
  codeHint: string;
  voided: boolean;
}

export async function fetchRecentCashTopUps(): Promise<RecentCashTopUp[]> {
  const res = await authedFetch('/v1/reception/cash/recent');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Anular un cobro pagado con saldo: encargado o dueño, siempre con motivo y su 2FA. */
export async function reverseWalletCharge(
  target: { walletId: string; consumptionId: string },
  input: { reason: string; totpCode?: string },
  /** Sin 2FA: la prueba de la llave de acceso para esta anulación (stepUpActions.reverseConsumption). */
  stepUpToken?: string,
): Promise<{ refundedCents: number; newBalanceCents: number }> {
  const res = await authedFetch(
    `/v1/wallets/${encodeURIComponent(target.walletId)}/consumptions/${encodeURIComponent(target.consumptionId)}/reverse`,
    { method: 'POST', body: JSON.stringify(input), ...(stepUpToken ? { headers: { [STEP_UP_TOKEN_HEADER]: stepUpToken } } : {}) },
  );
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Anular una recarga en efectivo mal tecleada: encargado o dueño, siempre con su 2FA. */
export async function voidCashTopUp(
  id: string,
  input: { reason: string; totpCode: string; serviceFeeCents?: number },
): Promise<{ voidId: string; topUpId: string; walletId: string; amountCents: number; serviceFeeCents?: number; balanceCents: number }> {
  const res = await authedFetch(`/v1/reception/cash/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}
