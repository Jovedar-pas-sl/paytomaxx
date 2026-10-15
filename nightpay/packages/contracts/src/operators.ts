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

// ─── Cuenta de cobro: formato según el método ──────────────────────
// Una dirección mal copiada en cripto no tiene vuelta atrás: se valida al
// guardarla (panel, PATCH y enlace de la chica).

const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const IBAN_FORMAT = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const EMAIL_PAYOUT_METHODS: ReadonlySet<PayoutMethod> = new Set<PayoutMethod>([
  'FASTERPAY_EMAIL',
  'PAYQUICKER_EMAIL',
  'PAYONEER_EMAIL',
]);

/** IBAN con su dígito de control (ISO 13616, mod 97 == 1). Admite espacios y minúsculas. */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!IBAN_FORMAT.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : Number(ch);
    remainder = (remainder * (value >= 10 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

/** Como se guarda: sin espacios alrededor; el IBAN, en mayúsculas y sin espacios. */
export function normalizePayoutAddress(method: PayoutMethod | null | undefined, address: string): string {
  const trimmed = address.trim();
  return method === 'SEPA_IBAN' ? trimmed.replace(/\s+/g, '').toUpperCase() : trimmed;
}

/** null si la dirección vale para el método (o no hay regla); si no, el motivo. */
export function payoutAddressProblem(
  method: PayoutMethod | null | undefined,
  address: string | null | undefined,
): string | null {
  if (!method || address === null || address === undefined) return null;
  const a = normalizePayoutAddress(method, address);
  switch (method) {
    case 'USDT_TRC20':
      return TRON_ADDRESS.test(a) ? null : 'La dirección USDT-TRC20 (Tron) empieza por T y tiene 34 caracteres';
    case 'USDT_BEP20':
    case 'USDC_POLY':
      return EVM_ADDRESS.test(a) ? null : 'La dirección BEP20/Polygon empieza por 0x y tiene 42 caracteres (0-9, a-f)';
    case 'USDC_SOL':
      return SOLANA_ADDRESS.test(a) ? null : 'La dirección de Solana tiene de 32 a 44 caracteres (sin 0, O, I ni l)';
    case 'SEPA_IBAN':
      return isValidIban(a) ? null : 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra)';
    default:
      return EMAIL_PAYOUT_METHODS.has(method) && !z.string().email().safeParse(a).success
        ? 'Para este método la cuenta es un email'
        : null;
  }
}

/** Cuando vienen método y dirección juntos, la dirección tiene que ser de ese método. */
function refinePayoutAddress(
  v: { payoutMethod?: PayoutMethod | null; payoutAddress?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (v.payoutMethod === undefined) return;
  const problem = payoutAddressProblem(v.payoutMethod, v.payoutAddress);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutAddress'], message: problem });
}

/** Enlace a un justificante: solo https (javascript:, data: o http: no). */
export const ReceiptUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https:\/\//i.test(u), 'El enlace del justificante tiene que empezar por https://');

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
}).superRefine(refinePayoutAddress);
export type UpdateOperatorDto = z.infer<typeof UpdateOperatorSchema>;

export const CreatePayoutSchema = z.object({
  notes: z.string().max(500).optional(),
  // Phase 1A — referencia externa opcional al crear (si admin ya hizo el envío)
  externalTxId: z.string().trim().min(4).max(200).optional(),
  externalRail: PayoutMethodSchema.optional(),
  receiptUrl: ReceiptUrlSchema.optional(),
  /** Código de la app de verificación (2FA), obligatorio si el dueño la activó. */
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
export type CreatePayoutDto = z.infer<typeof CreatePayoutSchema>;

/** Verificar un payout existente contra blockchain (cripto) o marcar manualmente OK. */
export const VerifyPayoutSchema = z.object({
  externalTxId: z.string().trim().min(4).max(200),
  externalRail: PayoutMethodSchema,
  receiptUrl: ReceiptUrlSchema.optional(),
  /** Si true, fuerza MANUAL_OK aunque el verifier auto pudiera correr. */
  manualOverride: z.boolean().optional(),
});
export type VerifyPayoutDto = z.infer<typeof VerifyPayoutSchema>;

/** Respuesta de la verificación */
export const VerifyPayoutResultSchema = z.object({
  matched: z.boolean(),
  status: ReconciliationStatusSchema,
  occurredAt: z.string().datetime().nullable(),
  /** Lo recibido en céntimos de EUR (con el tipo de cambio guardado en el pago); null si no se sabe. */
  actualAmountCents: z.number().int().nullable(),
  /** Lo recibido en la dirección de la chica, en USDT/USDC (suma de transferencias). */
  actualAmountUsdt: z.number().nullable().optional(),
  /** Motivo (`codigo: detalle`) cuando no cuadra o no se pudo comprobar. */
  reason: z.string().nullable(),
});
export type VerifyPayoutResult = z.infer<typeof VerifyPayoutResultSchema>;

/** Estadísticas treasury para tab admin */
export const TreasuryStatsSchema = z.object({
  /** Lo que hay que pagar ya (como createPayout): sin lo que está en espera y menos la deuda de cada chica. */
  pendingPayoutsCents: z.number().int(),
  /** Chicas con algo que cobrar ya. */
  pendingOperatorCount: z.number().int().nonnegative(),
  /** Comisiones aún en espera (PAYOUT_HOLD_DAYS): se pagarán más adelante. */
  heldPayoutsCents: z.number().int().nonnegative().optional(),
  /** Deuda abierta de las chicas por devoluciones tras un pago (se descuenta de sus pagos). */
  operatorDebtCents: z.number().int().nonnegative().optional(),
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

/**
 * Cuerpo de /admin/operators/:id/reset-password: o el dueño pone la
 * contraseña (8–128) o, sin ella (o vacía), el servidor genera una.
 */
export const ResetOperatorPasswordSchema = z
  .object({
    password: z
      .union([
        z.literal(''),
        z
          .string()
          .min(8, 'La contraseña necesita al menos 8 caracteres')
          .max(128, 'La contraseña admite como mucho 128 caracteres'),
      ])
      .optional(),
  })
  .default({});
export type ResetOperatorPasswordDto = z.infer<typeof ResetOperatorPasswordSchema>;

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
}).superRefine(refinePayoutAddress);
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
