import { z } from 'zod';
import { UuidSchema } from './common';

// ─── Phase 1A — Payout routing ─────────────────────────────────────

/** Métodos de payout soportados. Categorías:
 *  - CRYPTO_ONCHAIN: requiere verifier on-chain (Tronscan/Bscscan/Polygonscan/Solscan).
 *  - EXCHANGE_INTERNAL / EWALLET / BANK_WIRE / WALLET_LATAM / MANUAL_CASH: reconciliación manual.
 */
export const PayoutMethodSchema = z.enum([
  // Cripto on-chain (verificación automática)
  'USDT_TRC20',
  'USDT_BEP20',
  'USDC_POLY',
  'USDC_SOL',
  // Exchange internal (semi-manual)
  'BINANCE_PAY_ID',
  'OKX_INTERNAL',
  'BYBIT_INTERNAL',
  // E-wallets (manual con ref)
  'FASTERPAY_EMAIL',
  'PAYQUICKER_EMAIL',
  'HYPERWALLET_TOKEN',
  'REVOLUT_TAG',
  'PAYONEER_EMAIL',
  // Bank wires (manual con ref)
  'SEPA_IBAN',
  'WIRE_INTERNATIONAL',
  // Wallets LatAm locales (manual)
  'MERCADOPAGO_CVU',
  'PIX_KEY',
  'NEQUI_PHONE',
  'DAVIPLATA_PHONE',
  // Efectivo
  'MANUAL_CASH',
]);
export type PayoutMethod = z.infer<typeof PayoutMethodSchema>;

/** Estado de reconciliación de un payout. */
export const ReconciliationStatusSchema = z.enum([
  'UNRECONCILED', // pendiente o sin externalTxId
  'MATCHED',      // verificado automáticamente (on-chain)
  'MANUAL_OK',    // admin confirma manualmente (sin verificación auto)
  'MISMATCH',     // verificación auto falló (importe/destino no cuadra)
]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

/** Metadata extra del payout (bank wires) */
export const PayoutMetadataSchema = z.object({
  bankName: z.string().max(80).optional(),
  swiftBic: z.string().max(20).optional(),
  country: z.string().max(80).optional(),
  accountHolder: z.string().max(120).optional(),
}).passthrough(); // permite campos extra forward-compat
export type PayoutMetadata = z.infer<typeof PayoutMetadataSchema>;

// ─── Phase 1A.1 — Onboarding tracking ──────────────────────────────

export const WalletProviderSchema = z.enum([
  'BINANCE', 'BYBIT', 'OKX', 'CRYPTO_COM', 'TRUST_WALLET',
  'FASTERPAY', 'PAYQUICKER', 'WISE', 'REVOLUT', 'OTHER', 'NONE',
]);
export type WalletProvider = z.infer<typeof WalletProviderSchema>;

export const WalletStatusSchema = z.enum([
  'NOT_STARTED',
  'REGISTERED',
  'KYC_PENDING',
  'KYC_VERIFIED',
  'KYC_REJECTED',
]);
export type WalletStatus = z.infer<typeof WalletStatusSchema>;

export const OnboardingStatusSchema = z.enum([
  'NEW',
  'PROFILE_CREATED',
  'INVITE_ACTIVATED',
  'BINANCE_PENDING',
  'READY',
  'BLOCKED',
]);
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

// ─── Vistas públicas ────────────────────────────────────────────────

/** Vista de operadora para listados de admin (no expone hash, totp). */
export const OperatorPublicViewSchema = z.object({
  id: UuidSchema,
  email: z.string().email(),
  displayName: z.string().nullable(),
  commissionBps: z.number().int().nonnegative(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  invitedAt: z.string().datetime().nullable(),
  // Phase 1A — routing del payout. Null si la chica aún no lo configuró.
  payoutMethod: PayoutMethodSchema.nullable().optional(),
  payoutAddress: z.string().nullable().optional(),
  payoutMetadata: PayoutMetadataSchema.nullable().optional(),
  payoutLabel: z.string().nullable().optional(),
  // Phase 1A.1 — Onboarding tracking
  phone: z.string().nullable().optional(),
  passportCountry: z.string().nullable().optional(),
  passportLast4: z.string().nullable().optional(),
  hasEmpadronamiento: z.boolean().optional(),
  hasNie: z.boolean().optional(),
  hasTie: z.boolean().optional(),
  walletProvider: WalletProviderSchema.nullable().optional(),
  walletStatus: WalletStatusSchema.nullable().optional(),
  walletTestPassed: z.boolean().optional(),
  walletTestAt: z.string().datetime().nullable().optional(),
  needsHelpWallet: z.boolean().optional(),
  needsHelpDocs: z.boolean().optional(),
  onboardingStatus: OnboardingStatusSchema.optional(),
  onboardingNotes: z.string().nullable().optional(),
});
export type OperatorPublicView = z.infer<typeof OperatorPublicViewSchema>;

/** Saldo agregado de la operadora — puede ser negativo si refunds > earnings. */
export const OperatorBalanceSchema = z.object({
  /** Todo lo no pagado, menos la deuda por devoluciones. */
  pendingCents: z.number().int(),
  /** Parte de pendingCents que ya entra en el próximo pago (pasados los días de espera). */
  availableCents: z.number().int(),
  /** Comisiones recientes aún en espera. */
  heldCents: z.number().int().nonnegative(),
  /** Devoluciones llegadas después de un pago, a descontar del siguiente. */
  debtCents: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
  lifetimeGrossCents: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
export type OperatorBalance = z.infer<typeof OperatorBalanceSchema>;

/** Earning individual con info del payment asociado. */
export const EarningViewSchema = z.object({
  id: UuidSchema,
  paymentId: UuidSchema.nullable(),
  paymentAmountCents: z.number().int(),
  commissionBps: z.number().int(),
  commissionCents: z.number().int(),
  /** Propinas asignadas al earning (independiente de commissionCents). */
  tipCents: z.number().int().nonnegative().default(0),
  reversedCents: z.number().int().nonnegative(),
  /** netCents = commissionCents + tipCents - reversedCents */
  netCents: z.number().int(),
  payoutId: UuidSchema.nullable(),
  paymentStatus: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type EarningView = z.infer<typeof EarningViewSchema>;

/** Liquidación pasada de admin → operadora. */
export const PayoutViewSchema = z.object({
  id: UuidSchema,
  totalCents: z.number().int(),
  paidByEmail: z.string().email().nullable(),
  notes: z.string().nullable(),
  earningCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  // Phase 1A — reconciliación
  externalTxId: z.string().nullable().optional(),
  externalRail: PayoutMethodSchema.nullable().optional(),
  reconciliationStatus: ReconciliationStatusSchema.optional(),
  receiptUrl: z.string().url().nullable().optional(),
  reconciledAt: z.string().datetime().nullable().optional(),
});
export type PayoutView = z.infer<typeof PayoutViewSchema>;

/** Vista enriquecida en el panel admin con saldo agregado. */
export const OperatorWithBalanceSchema = OperatorPublicViewSchema.extend({
  balance: OperatorBalanceSchema,
});
export type OperatorWithBalance = z.infer<typeof OperatorWithBalanceSchema>;

// ─── DTOs ───────────────────────────────────────────────────────────

export const CreateOperatorSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  commissionBps: z.number().int().min(0).max(10_000).describe('basis points: 1500 = 15%'),
});
export type CreateOperatorDto = z.infer<typeof CreateOperatorSchema>;

export const UpdateOperatorSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  commissionBps: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
  // Phase 1A — payout routing
  payoutMethod: PayoutMethodSchema.nullable().optional(),
  payoutAddress: z.string().min(1).max(200).nullable().optional(),
  payoutMetadata: PayoutMetadataSchema.nullable().optional(),
  payoutLabel: z.string().max(120).nullable().optional(),
  // Phase 1A.1 — Onboarding
  phone: z.string().max(40).nullable().optional(),
  passportCountry: z.string().max(80).nullable().optional(),
  passportLast4: z.string().max(8).nullable().optional(),
  hasEmpadronamiento: z.boolean().optional(),
  hasNie: z.boolean().optional(),
  hasTie: z.boolean().optional(),
  walletProvider: WalletProviderSchema.nullable().optional(),
  walletStatus: WalletStatusSchema.nullable().optional(),
  walletTestPassed: z.boolean().optional(),
  needsHelpWallet: z.boolean().optional(),
  needsHelpDocs: z.boolean().optional(),
  onboardingStatus: OnboardingStatusSchema.optional(),
  onboardingNotes: z.string().max(2000).nullable().optional(),
});
export type UpdateOperatorDto = z.infer<typeof UpdateOperatorSchema>;

export const CreatePayoutSchema = z.object({
  notes: z.string().max(500).optional(),
  // Phase 1A — referencia externa opcional al crear (si admin ya hizo el envío)
  externalTxId: z.string().min(4).max(200).optional(),
  externalRail: PayoutMethodSchema.optional(),
  receiptUrl: z.string().url().max(500).optional(),
});
export type CreatePayoutDto = z.infer<typeof CreatePayoutSchema>;

/** Verificar un payout existente contra blockchain (cripto) o marcar manualmente OK. */
export const VerifyPayoutSchema = z.object({
  externalTxId: z.string().min(4).max(200),
  externalRail: PayoutMethodSchema,
  receiptUrl: z.string().url().max(500).optional(),
  /** Si true, fuerza MANUAL_OK aunque el verifier auto pudiera correr. */
  manualOverride: z.boolean().optional(),
});
export type VerifyPayoutDto = z.infer<typeof VerifyPayoutSchema>;

/** Respuesta de la verificación */
export const VerifyPayoutResultSchema = z.object({
  matched: z.boolean(),
  status: ReconciliationStatusSchema,
  occurredAt: z.string().datetime().nullable(),
  actualAmountCents: z.number().int().nullable(),
  reason: z.string().nullable(),
});
export type VerifyPayoutResult = z.infer<typeof VerifyPayoutResultSchema>;

/** Estadísticas treasury para tab admin */
export const TreasuryStatsSchema = z.object({
  pendingPayoutsCents: z.number().int(),
  pendingOperatorCount: z.number().int().nonnegative(),
  payoutsThisMonthCount: z.number().int().nonnegative(),
  payoutsThisMonthCents: z.number().int().nonnegative(),
  byMethod: z.record(z.string(), z.number().int().nonnegative()),
  byReconciliationStatus: z.record(z.string(), z.number().int().nonnegative()),
});
export type TreasuryStats = z.infer<typeof TreasuryStatsSchema>;

export const AcceptInviteSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(8).max(128),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;

// ─── Self-onboarding (Phase 1A.2) ───────────────────────────────────
// La chica recibe un link único 72h del admin y rellena su perfil ella sola.

/** Vista pre-fill que recibe la chica al abrir el link (solo lo que admin ya sabe). */
export const SelfOnboardingProfileSchema = z.object({
  displayName: z.string().nullable(),
  email: z.string().email(),
  phone: z.string().nullable(),
  passportCountry: z.string().nullable(),
  passportLast4: z.string().nullable(),
  hasEmpadronamiento: z.boolean(),
  hasNie: z.boolean(),
  hasTie: z.boolean(),
  walletProvider: WalletProviderSchema.nullable(),
  walletStatus: WalletStatusSchema.nullable(),
  walletTestPassed: z.boolean(),
  needsHelpWallet: z.boolean(),
  needsHelpDocs: z.boolean(),
  onboardingNotes: z.string().nullable(),
  payoutMethod: PayoutMethodSchema.nullable(),
  payoutAddress: z.string().nullable(),
  payoutLabel: z.string().nullable(),
  venueName: z.string(),
});
export type SelfOnboardingProfile = z.infer<typeof SelfOnboardingProfileSchema>;

/** Lo que la chica submite — subset de UpdateOperatorDto, no toca commission/active. */
export const SelfOnboardingSubmitSchema = z.object({
  phone: z.string().max(40).nullable().optional(),
  passportCountry: z.string().max(80).nullable().optional(),
  passportLast4: z.string().max(8).nullable().optional(),
  hasEmpadronamiento: z.boolean().optional(),
  hasNie: z.boolean().optional(),
  hasTie: z.boolean().optional(),
  walletProvider: WalletProviderSchema.nullable().optional(),
  walletStatus: WalletStatusSchema.nullable().optional(),
  walletTestPassed: z.boolean().optional(),
  needsHelpWallet: z.boolean().optional(),
  needsHelpDocs: z.boolean().optional(),
  onboardingNotes: z.string().max(2000).nullable().optional(),
  // Phase 1A — la chica puede registrar su address de payout también
  payoutMethod: PayoutMethodSchema.nullable().optional(),
  payoutAddress: z.string().min(1).max(200).nullable().optional(),
  payoutLabel: z.string().max(120).nullable().optional(),
});
export type SelfOnboardingSubmitDto = z.infer<typeof SelfOnboardingSubmitSchema>;

/** Respuesta del endpoint admin que crea el link. */
export const SelfOnboardingLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type SelfOnboardingLinkResponse = z.infer<typeof SelfOnboardingLinkResponseSchema>;

/** Respuesta del endpoint createOperator — incluye URL de invite (para copiar a WhatsApp si SMTP off). */
export const CreateOperatorResponseSchema = z.object({
  operator: OperatorPublicViewSchema,
  inviteUrl: z.string().url().describe('Link único para set-password — TTL 24h'),
  emailSent: z.boolean(),
});
export type CreateOperatorResponse = z.infer<typeof CreateOperatorResponseSchema>;
