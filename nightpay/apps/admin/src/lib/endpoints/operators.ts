// Operadoras: alta, edición, ganancias, liquidaciones y tesorería.

import type {
  ApprovalRequestedResponse,
  OxiocardStatus,
  BankHoldList,
  BankReleaseResult,
  IdDocumentFull,
  IdDocumentInput,
  IdDocumentType,
  PayoutAccountFull,
  ReleaseBankHoldDto,
  StaffCardView,
} from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';

export interface OperatorBalance {
  pendingCents: number;
  /** Lo que se pagaría ahora: comisiones pasados los días de espera, menos deuda (y sin lo retenido). */
  availableCents?: number;
  heldCents?: number;
  /** API nuevo: ventas por datáfono sin cuadrar con el banco (su parte no se paga hasta cuadrarlas). */
  bankHeldCents?: number;
  bankHeldCount?: number;
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
  /** Huella de su foto de perfil (Mi perfil), o null sin foto. */
  photoHash?: string | null;
  commissionBps: number;
  active: boolean;
  invitedAt: string | null;
  createdAt: string;
  balance: OperatorBalance;
  // Phase 1A — payout. La cuenta llega siempre tapada; entera, solo el dueño
  // con «Ver cuenta para pagar» (revealOperatorPayoutAccount, 2FA).
  payoutMethod?: PayoutMethod | null;
  payoutAddressMasked?: string | null;
  /** Banco, SWIFT y país (el titular va tapado aparte). */
  payoutMetadata?: PayoutMetadata | null;
  payoutHolderMasked?: string | null;
  /** El titular no se parece a su nombre: aviso para el dueño. */
  payoutHolderMismatch?: boolean;
  payoutLabel?: string | null;
  payoutAccountChangedAt?: string | null;
  /** Cuenta cambiada hace menos de 48 h: hasta entonces no se le paga a ella (salvo en efectivo). */
  payoutHoldUntil?: string | null;
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
  // Alta con tres caminos. El nombre legal solo llega tapado.
  legalNameMasked?: string | null;
  /** «AAAA-MM-DD». */
  birthDate?: string | null;
  /** El titular no coincide con su nombre legal y el dueño aún no confirmó que la cuenta es suya. */
  payoutHolderUnconfirmed?: boolean;
  /** Solo con la OxioCard encendida (OXIOCARD_ENABLED). */
  oxiocardStatus?: OxiocardStatus;
  oxiocardStatusAt?: string | null;
  /** Su documento (cifrado): el tipo y el número tapado («•••• 678Z»). Entero: el dueño con 2FA. */
  idDocumentType?: IdDocumentType | null;
  idDocumentMasked?: string | null;
  /** Su ficha NFC viva («Ficha nº 0522»); null sin ficha. Las APIs de antes no la mandan. */
  staffCard?: StaffCardView | null;
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
  /** API nuevo: ventas por datáfono sin cuadrar con el banco (se pagan al cuadrarlas o liberarlas). */
  bankHeldPayoutsCents?: number;
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

/** Las chicas; con 'WAITER', los camareros (su parte de las invitaciones se les paga igual). */
export async function fetchOperators(role: 'OPERATOR' | 'WAITER' = 'OPERATOR'): Promise<Operator[]> {
  const res = await authedFetch(role === 'WAITER' ? '/v1/admin/operators?role=WAITER' : '/v1/admin/operators');
  if (!res.ok) throw new Error(role === 'WAITER' ? 'Error cargando los camareros' : 'Error cargando operadoras');
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
    // Solo el dueño: nombre legal, fecha de nacimiento, «la cuenta es suya» (con 2FA) y la OxioCard.
    legalName?: string;
    birthDate?: string;
    payoutHolderConfirmed?: true;
    oxiocardStatus?: OxiocardStatus;
    /** Su documento (se guarda cifrado); null lo quita. */
    idDocument?: IdDocumentInput | null;
    /** Código 2FA: cambiar la cuenta de cobro lo pide siempre (sin 2FA activada, el API dice que la active). */
    totpCode?: string;
  },
): Promise<Omit<Operator, 'balance'>> {
  const res = await authedFetch(`/v1/admin/operators/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/**
 * «Ver documento»: el DNI, NIE o pasaporte entero de una compañera. Solo el
 * dueño y con su código 2FA; queda en el registro, tapado.
 */
export async function revealOperatorIdDocument(id: string, totpCode: string): Promise<IdDocumentFull> {
  const res = await authedFetch(`/v1/admin/operators/${id}/id-document/reveal`, {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

/** Su ficha NFC: la recién grabada pasa a ser la suya (la de antes deja de valer al momento). */
export async function issueStaffCard(id: string, input: { card: string; uid: string }): Promise<StaffCardView> {
  const res = await authedFetch(`/v1/admin/operators/${id}/staff-card`, { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** Anular su ficha NFC (la ha perdido): deja de valer al momento. */
export async function revokeStaffCard(id: string): Promise<{ revoked: number | null }> {
  const res = await authedFetch(`/v1/admin/operators/${id}/staff-card`, { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/**
 * «Ver cuenta para pagar»: la cuenta entera (y el titular) de una compañera.
 * Solo el dueño y con su código 2FA; queda en el registro, tapada.
 */
export async function revealOperatorPayoutAccount(id: string, totpCode: string): Promise<PayoutAccountFull> {
  const res = await authedFetch(`/v1/admin/operators/${id}/payout-account/reveal`, {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
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

/** El pago quedó hecho (201). */
export interface PayoutCreated {
  id: string;
  totalCents: number;
  earningCount: number;
  createdAt: string;
}

/**
 * Pagar a la chica (201: pagado) o, si el local pide la aprobación del dueño
 * para los pagos del encargado, pedirlo (202: «pedido al dueño», ver isPayoutRequested).
 */
export async function createOperatorPayout(
  id: string,
  options?: {
    notes?: string;
    externalTxId?: string;
    externalRail?: PayoutMethod;
    receiptUrl?: string;
    /** Código 2FA (obligatorio si el dueño lo tiene activado). */
    totpCode?: string;
    /**
     * La cifra que vio el dueño: si lo pagable ya es otra, el API responde
     * 409 PAYOUT_CHANGED en vez de apuntar más (o menos) de lo que se dio.
     */
    expectedTotalCents?: number;
    /** La del intento: repetirlo (sin respuesta) no apunta el pago dos veces. Va en la cabecera. */
    idempotencyKey?: string;
  },
): Promise<PayoutCreated | ApprovalRequestedResponse> {
  const { idempotencyKey, ...body } = options ?? {};
  // El encargado con aprobación del local: 202 «pedido al dueño» (isApprovalRequested).
  const res = await authedFetch(`/v1/admin/operators/${id}/payouts`, {
    method: 'POST',
    ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

// ─── Ventas por datáfono sin cuadrar con el banco (H-1) ─────────────

/** Lo retenido de esta persona: total, ventas y cada una (con si quien mira la puede liberar). */
export async function fetchBankHolds(operatorId: string): Promise<BankHoldList> {
  const res = await authedFetch(`/v1/admin/operators/${operatorId}/bank-holds`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

/** El dueño libera la comisión retenida de una venta por datáfono: 2FA siempre. */
export async function releaseBankHold(paymentId: string, body: ReleaseBankHoldDto): Promise<BankReleaseResult> {
  const res = await authedFetch(`/v1/admin/payments/${paymentId}/bank-release`, { method: 'POST', body: JSON.stringify(body) });
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
