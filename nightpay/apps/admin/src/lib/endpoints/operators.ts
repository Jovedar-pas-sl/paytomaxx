// Operadoras: alta, edición, ganancias, liquidaciones y tesorería.

import type { ApprovalRequestedResponse } from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';

export interface OperatorBalance {
  pendingCents: number;
  /** Lo que se pagaría ahora: comisiones pasados los días de espera, menos deuda. */
  availableCents?: number;
  heldCents?: number;
  debtCents?: number;
  paidCents: number;
  lifetimeGrossCents: number;
  count: number;
}

export type PayoutMethod =
  | 'USDT_TRC20'
  | 'USDT_BEP20'
  | 'USDC_POLY'
  | 'USDC_SOL'
  | 'BINANCE_PAY_ID'
  | 'OKX_INTERNAL'
  | 'BYBIT_INTERNAL'
  | 'FASTERPAY_EMAIL'
  | 'PAYQUICKER_EMAIL'
  | 'HYPERWALLET_TOKEN'
  | 'REVOLUT_TAG'
  | 'PAYONEER_EMAIL'
  | 'SEPA_IBAN'
  | 'WIRE_INTERNATIONAL'
  | 'MERCADOPAGO_CVU'
  | 'PIX_KEY'
  | 'NEQUI_PHONE'
  | 'DAVIPLATA_PHONE'
  | 'MANUAL_CASH';

export type ReconciliationStatus = 'UNRECONCILED' | 'MATCHED' | 'MANUAL_OK' | 'MISMATCH';

export interface PayoutMetadata {
  bankName?: string;
  swiftBic?: string;
  country?: string;
  accountHolder?: string;
}

export type WalletProvider =
  | 'BINANCE' | 'BYBIT' | 'OKX' | 'CRYPTO_COM' | 'TRUST_WALLET'
  | 'FASTERPAY' | 'PAYQUICKER' | 'WISE' | 'REVOLUT' | 'OTHER' | 'NONE';

export type WalletStatus =
  | 'NOT_STARTED' | 'REGISTERED' | 'KYC_PENDING' | 'KYC_VERIFIED' | 'KYC_REJECTED';

export type OnboardingStatus =
  | 'NEW' | 'PROFILE_CREATED' | 'INVITE_ACTIVATED' | 'BINANCE_PENDING' | 'READY' | 'BLOCKED';

export interface Operator {
  id: string;
  email: string;
  displayName: string | null;
  commissionBps: number;
  active: boolean;
  invitedAt: string | null;
  createdAt: string;
  balance: OperatorBalance;
  // Phase 1A — payout
  payoutMethod?: PayoutMethod | null;
  payoutAddress?: string | null;
  payoutMetadata?: PayoutMetadata | null;
  payoutLabel?: string | null;
  // Phase 1A.1 — onboarding
  phone?: string | null;
  passportCountry?: string | null;
  passportLast4?: string | null;
  hasEmpadronamiento?: boolean;
  hasNie?: boolean;
  hasTie?: boolean;
  walletProvider?: WalletProvider | null;
  walletStatus?: WalletStatus | null;
  walletTestPassed?: boolean;
  walletTestAt?: string | null;
  needsHelpWallet?: boolean;
  needsHelpDocs?: boolean;
  onboardingStatus?: OnboardingStatus;
  onboardingNotes?: string | null;
}

export interface OperatorEarning {
  id: string;
  paymentId: string;
  paymentAmountCents: number;
  commissionBps: number;
  commissionCents: number;
  reversedCents: number;
  netCents: number;
  payoutId: string | null;
  paymentStatus: string;
  createdAt: string;
}

export interface OperatorPayout {
  id: string;
  totalCents: number;
  paidByEmail: string | null;
  notes: string | null;
  earningCount: number;
  createdAt: string;
  externalTxId?: string | null;
  externalRail?: PayoutMethod | null;
  reconciliationStatus?: ReconciliationStatus;
  receiptUrl?: string | null;
  reconciledAt?: string | null;
}

export interface TreasuryStats {
  pendingPayoutsCents: number;
  pendingOperatorCount: number;
  /** API nuevo: comisiones aún en espera (se pagarán más adelante). */
  heldPayoutsCents?: number;
  /** API nuevo: deuda de las chicas por devoluciones tras un pago. */
  operatorDebtCents?: number;
  payoutsThisMonthCount: number;
  payoutsThisMonthCents: number;
  byMethod: Record<string, number>;
  byReconciliationStatus: Record<string, number>;
}

export interface VerifyPayoutResult {
  matched: boolean;
  status: ReconciliationStatus;
  occurredAt: string | null;
  actualAmountCents: number | null;
  /** API nuevo: lo que llegó on-chain, en USDT/USDC. */
  actualAmountUsdt?: number | null;
  reason: string | null;
}

export interface CreateOperatorResponse {
  operator: Omit<Operator, 'balance'>;
  inviteUrl: string;
  emailSent: boolean;
  /** API nuevo: aviso (p. ej. el encargado no fija la comisión: se aplica la del local). */
  notice?: string;
}

// ─── Operadoras ────────────────────────────────────────────────────

export async function fetchOperators(): Promise<Operator[]> {
  const res = await authedFetch('/v1/admin/operators');
  if (!res.ok) throw new Error('Error cargando operadoras');
  return res.json();
}

export async function createOperator(input: {
  email: string;
  displayName: string;
  commissionBps: number;
}): Promise<CreateOperatorResponse> {
  const res = await authedFetch('/v1/admin/operators', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateOperator(
  id: string,
  input: {
    displayName?: string;
    commissionBps?: number;
    active?: boolean;
    payoutMethod?: PayoutMethod | null;
    payoutAddress?: string | null;
    payoutMetadata?: PayoutMetadata | null;
    payoutLabel?: string | null;
    // Onboarding fields
    phone?: string | null;
    passportCountry?: string | null;
    passportLast4?: string | null;
    hasEmpadronamiento?: boolean;
    hasNie?: boolean;
    hasTie?: boolean;
    walletProvider?: WalletProvider | null;
    walletStatus?: WalletStatus | null;
    walletTestPassed?: boolean;
    needsHelpWallet?: boolean;
    needsHelpDocs?: boolean;
    onboardingStatus?: OnboardingStatus;
    onboardingNotes?: string | null;
  },
): Promise<Omit<Operator, 'balance'>> {
  const res = await authedFetch(`/v1/admin/operators/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Genera (o rota) un link self-onboarding 72h para la operadora. El admin
 * copia el link y se lo manda a la chica vía WhatsApp. Ella lo abre sin login.
 */
export async function createSelfOnboardingLink(
  operatorId: string,
): Promise<{ url: string; expiresAt: string }> {
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/self-onboarding-link`, {
    method: 'POST',
    body: '{}',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Re-emite invite link 24h para una operadora todavía sin activar (estado
 * "pendiente"). Si la chica ya activó pass → 409, usar resetOperatorPassword.
 */
export async function regenerateInvite(
  operatorId: string,
): Promise<{ inviteUrl: string; expiresAt: string }> {
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/regenerate-invite`, {
    method: 'POST',
    body: '{}',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Resetea la contraseña de la operadora. Si `password` es null → backend
 * genera una random 12 chars. Devuelve la pass en CLARO una sola vez para
 * que el admin la copie y la mande por WhatsApp.
 */
export async function resetOperatorPassword(
  operatorId: string,
  password: string | null,
): Promise<{ password: string; reset: true }> {
  const body = password ? { password } : {};
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchOperatorEarnings(id: string): Promise<OperatorEarning[]> {
  const res = await authedFetch(`/v1/admin/operators/${id}/earnings`);
  if (!res.ok) throw new Error('Error cargando earnings');
  return res.json();
}

export async function fetchOperatorPayouts(id: string): Promise<OperatorPayout[]> {
  const res = await authedFetch(`/v1/admin/operators/${id}/payouts`);
  if (!res.ok) throw new Error('Error cargando payouts');
  return res.json();
}

export async function createOperatorPayout(
  id: string,
  options?: {
    notes?: string;
    externalTxId?: string;
    externalRail?: PayoutMethod;
    receiptUrl?: string;
    /** Código 2FA (obligatorio si el dueño lo tiene activado). */
    totpCode?: string;
  },
): Promise<{ id: string; totalCents: number; earningCount: number; createdAt: string } | ApprovalRequestedResponse> {
  // El encargado con aprobación del local: 202 «pedido al dueño» (isApprovalRequested).
  const res = await authedFetch(`/v1/admin/operators/${id}/payouts`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

// ─── Treasury (Phase 1A) ───────────────────────────────────────────

export async function fetchTreasuryStats(): Promise<TreasuryStats> {
  const res = await authedFetch('/v1/admin/treasury/stats');
  if (!res.ok) throw new Error('Error cargando treasury stats');
  return res.json();
}

export async function fetchExchangeRate(): Promise<{
  pair: string;
  rate: number;
  at: string;
  degraded: boolean;
}> {
  const res = await authedFetch('/v1/admin/treasury/exchange-rate');
  if (!res.ok) throw new Error('Error cargando exchange rate');
  return res.json();
}

export async function verifyPayout(
  payoutId: string,
  input: {
    externalTxId: string;
    externalRail: PayoutMethod;
    receiptUrl?: string;
    manualOverride?: boolean;
  },
): Promise<VerifyPayoutResult> {
  const res = await authedFetch(`/v1/admin/treasury/payouts/${payoutId}/verify`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * Marca un pago a una chica como confirmado a mano (métodos sin verificación
 * automática). El API pide al menos una prueba: referencia, recibo o nota.
 */
export async function confirmPayoutManual(
  payoutId: string,
  artifact: { externalTxId?: string; receiptUrl?: string; notes?: string },
): Promise<{ ok: true }> {
  const res = await authedFetch(`/v1/admin/treasury/payouts/${payoutId}/confirm-manual`, {
    method: 'POST',
    body: JSON.stringify(artifact),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function reconcilePending(): Promise<{ checked: number; matched: number }> {
  const res = await authedFetch('/v1/admin/treasury/reconcile', {
    method: 'POST',
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
