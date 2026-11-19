import { displayNameSchema } from './profile';
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
/** País y dígitos de control al principio: se trata como IBAN (también en la transferencia internacional). */
const LOOKS_LIKE_IBAN = /^[A-Z]{2}\d{2}/;
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

/**
 * Como se guarda: sin espacios alrededor; el IBAN, en mayúsculas y sin
 * espacios (también el de una transferencia internacional, como el panel).
 */
export function normalizePayoutAddress(method: PayoutMethod | null | undefined, address: string): string {
  const trimmed = address.trim();
  if (method === 'SEPA_IBAN') return trimmed.replace(/\s+/g, '').toUpperCase();
  if (method === 'WIRE_INTERNATIONAL') {
    const compact = trimmed.replace(/[\s-]+/g, '').toUpperCase();
    if (LOOKS_LIKE_IBAN.test(compact)) return compact;
  }
  return trimmed;
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

// ─── El alta por enlace: cada método con su forma ───────────────────
// La chica lo teclea en el móvil: además de lo de arriba, la forma de cada
// método y, en la transferencia internacional, los datos del banco. El panel
// del dueño sigue con payoutAddressProblem (más permisivo: si algo raro no
// cabe aquí, lo pone el dueño) y lo ya guardado no se revalida.

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SWIFT_BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?\d{7,15}$/;
const CO_MOBILE = /^(?:\+?57)?3\d{9}$/;
const CBU_ALIAS = /^[A-Za-z0-9.-]{6,20}$/;
const REVOLUT_TAG = /^@[A-Za-z0-9._-]{3,32}$/;
const HYPERWALLET_TOKEN = /^[a-z]{3}-[0-9a-f-]{8,}$/i;
const ACCOUNT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 -]{3,39}$/;

function isEmail(value: string): boolean {
  return z.string().email().safeParse(value).success;
}

/** Como se teclea un teléfono, un CPF o un CVU: sin espacios, puntos, guiones, barras ni paréntesis. */
function compactNumber(value: string): string {
  return value.replace(/[\s.\-/()]/g, '');
}

/** Cuántos bytes son una cadena en base58 (null si no es base58). */
function base58ByteLength(value: string): number | null {
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const leadingZeros = value.length - value.replace(/^1+/, '').length;
  return leadingZeros + bytes.length;
}

/** Clave Pix: email, clave aleatoria, CPF (11), CNPJ (14) o teléfono (de Brasil si lleva +). */
function isPixKey(value: string): boolean {
  if (isEmail(value) || UUID.test(value)) return true;
  const n = compactNumber(value);
  return n.startsWith('+') ? /^\+55\d{10,11}$/.test(n) : /^\d{10,14}$/.test(n);
}

/** SWIFT/BIC: banco (4 letras), país (2), sitio (2) y, si lo lleva, la oficina (3). */
export function isValidSwiftBic(raw: string): boolean {
  return SWIFT_BIC.test(raw.replace(/\s+/g, '').toUpperCase());
}

/**
 * null si la cuenta vale para el método en el alta; si no, el motivo. Lo de
 * payoutAddressProblem y, además, la forma de cada método.
 */
export function payoutFormatProblem(method: PayoutMethod, address: string): string | null {
  const base = payoutAddressProblem(method, address);
  if (base) return base;
  const a = normalizePayoutAddress(method, address);
  switch (method) {
    case 'USDC_SOL':
      // Una de Tron o de Bitcoin también es base58 y cabe en 32-44 letras, pero no son 32 bytes.
      return base58ByteLength(a) === 32 ? null : 'Esa no es una dirección de Solana (¿es de otra red?): copia la de USDC en Solana';
    case 'BINANCE_PAY_ID':
      return /^\d{6,12}$/.test(compactNumber(a)) ? null : 'El Binance Pay ID son solo números (de 6 a 12): lo ves en Binance → Pay';
    case 'OKX_INTERNAL':
    case 'BYBIT_INTERNAL':
      return /^\d{5,20}$/.test(compactNumber(a)) || isEmail(a) || PHONE.test(compactNumber(a))
        ? null
        : 'Pon tu UID (solo números), o el email o el teléfono de tu cuenta';
    case 'HYPERWALLET_TOKEN':
      return HYPERWALLET_TOKEN.test(a) || isEmail(a) ? null : 'Pon el token de Hyperwallet (empieza por usr-) o el email de tu cuenta';
    case 'REVOLUT_TAG':
      return REVOLUT_TAG.test(a) || PHONE.test(compactNumber(a))
        ? null
        : 'Pon tu @tag de Revolut (p. ej. @ana123) o el teléfono de tu cuenta';
    case 'MERCADOPAGO_CVU':
      return /^\d{22}$/.test(compactNumber(a)) || CBU_ALIAS.test(a)
        ? null
        : 'El CVU (o CBU) son 22 números; o pon tu alias (de 6 a 20 letras, números, puntos o guiones)';
    case 'PIX_KEY':
      return isPixKey(a) ? null : 'Una clave Pix es tu CPF o CNPJ, tu teléfono (+55…), tu email o la clave aleatoria';
    case 'NEQUI_PHONE':
    case 'DAVIPLATA_PHONE':
      return CO_MOBILE.test(compactNumber(a))
        ? null
        : 'Pon el móvil de Colombia de tu cuenta: 10 números que empiezan por 3 (con o sin +57)';
    case 'WIRE_INTERNATIONAL':
      if (LOOKS_LIKE_IBAN.test(a)) return isValidIban(a) ? null : 'Ese IBAN no es válido: revisa las letras y los números';
      return ACCOUNT_NUMBER.test(a) ? null : 'Pon el IBAN o el número de cuenta (letras y números)';
    default:
      return null;
  }
}

export type WireDetailField = 'bankName' | 'swiftBic' | 'accountHolder';

/** Lo que falta en los datos del banco de una transferencia internacional (el país, opcional). */
export function wireDetailsProblems(
  meta: PayoutMetadata | null | undefined,
): Array<{ field: WireDetailField; message: string }> {
  const problems: Array<{ field: WireDetailField; message: string }> = [];
  if (!meta?.bankName?.trim()) problems.push({ field: 'bankName', message: 'Falta el nombre del banco' });
  const swift = meta?.swiftBic?.trim() ?? '';
  if (!swift) problems.push({ field: 'swiftBic', message: 'Falta el SWIFT/BIC del banco' });
  else if (!isValidSwiftBic(swift)) {
    problems.push({ field: 'swiftBic', message: 'El SWIFT/BIC son 8 u 11 letras y números (p. ej. TBCBGE22)' });
  }
  if (!meta?.accountHolder?.trim()) problems.push({ field: 'accountHolder', message: 'Falta el titular de la cuenta' });
  return problems;
}

/** Los datos del banco como se guardan: sin espacios sobrantes, el SWIFT junto y en mayúsculas, sin vacíos. */
export function normalizeWireDetails(meta: PayoutMetadata | null | undefined): PayoutMetadata | null {
  if (!meta) return null;
  const clean: Record<string, string | undefined> = {
    bankName: meta.bankName?.trim(),
    swiftBic: meta.swiftBic?.replace(/\s+/g, '').toUpperCase(),
    country: meta.country?.trim(),
    accountHolder: meta.accountHolder?.trim(),
  };
  const entries = Object.entries(clean).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

// ─── Titular de la cuenta ────────────────────────────────────────────
// En una transferencia el banco pide el nombre del titular (en SEPA, además,
// comprueba que cuadre con el IBAN): sin él no se guarda una cuenta nueva.

/** Métodos que llevan titular (SEPA y la transferencia internacional). */
const HOLDER_METHODS: ReadonlySet<string> = new Set<PayoutMethod>(['SEPA_IBAN', 'WIRE_INTERNATIONAL']);

export const PAYOUT_HOLDER_MISSING = 'Falta el titular de la cuenta';

export function payoutHolderRequired(method: PayoutMethod | string | null | undefined): boolean {
  return Boolean(method && HOLDER_METHODS.has(method));
}

/** null si el método no lleva titular o lo tiene; si no, el motivo. */
export function payoutHolderProblem(
  method: PayoutMethod | string | null | undefined,
  meta: PayoutMetadata | null | undefined,
): string | null {
  return payoutHolderRequired(method) && !meta?.accountHolder?.trim() ? PAYOUT_HOLDER_MISSING : null;
}

/**
 * Los datos del banco que se guardan con cada método: la transferencia
 * internacional, los suyos (normalizeWireDetails); el IBAN SEPA, solo el
 * titular; los demás, ninguno.
 */
export function payoutMetadataFor(
  method: PayoutMethod | string | null | undefined,
  meta: PayoutMetadata | null | undefined,
): PayoutMetadata | null {
  if (method === 'WIRE_INTERNATIONAL') return normalizeWireDetails(meta);
  if (method === 'SEPA_IBAN') {
    const holder = meta?.accountHolder?.trim();
    return holder ? { accountHolder: holder } : null;
  }
  return null;
}

/** El titular tapado para los listados: la inicial de cada palabra («M••• L•••»). */
export function maskHolderName(name: string | null | undefined): string | null {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => `${w.charAt(0).toUpperCase()}•••`).join(' ');
}

/** Palabras de un nombre para compararlo: sin acentos, en minúsculas y de 3 letras o más. */
function nameWords(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);
}

/**
 * ¿El titular se parece al nombre de la compañera? Basta una palabra en común
 * (o que una empiece por la otra: «Ale» y «Alejandra»). Sin nombre o sin
 * titular no se puede comparar: true (no se avisa). Es un aviso, no bloquea.
 */
export function holderMatchesName(holder: string | null | undefined, name: string | null | undefined): boolean {
  const a = nameWords(holder ?? '');
  const b = nameWords(name ?? '');
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
}

// ─── Cambiar la cuenta de cobro: 48 h de espera ──────────────────────

/** Horas tras un cambio de cuenta durante las que no se paga a la cuenta nueva (salvo en efectivo). */
export const PAYOUT_ACCOUNT_HOLD_HOURS = 48;

/** 409 de «Marcar pagado» a una cuenta cambiada hace menos de 48 h (lleva `payableFrom`). */
export const PAYOUT_ACCOUNT_TOO_NEW = 'PAYOUT_ACCOUNT_TOO_NEW';

/** El alta: con método, la cuenta es obligatoria (salvo efectivo) y con su forma; el SWIFT, con su banco. */
function refineSelfOnboardingPayout(
  v: { payoutMethod?: PayoutMethod | null; payoutAddress?: string | null; payoutMetadata?: PayoutMetadata | null },
  ctx: z.RefinementCtx,
): void {
  const method = v.payoutMethod;
  if (!method) return;
  if (method !== 'MANUAL_CASH') {
    const address = v.payoutAddress?.trim() ?? '';
    const problem = address ? payoutFormatProblem(method, address) : 'Falta la dirección o la cuenta para este método';
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutAddress'], message: problem });
  }
  if (method === 'WIRE_INTERNATIONAL') {
    for (const p of wireDetailsProblems(v.payoutMetadata)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutMetadata', p.field], message: p.message });
    }
  } else {
    const holder = payoutHolderProblem(method, v.payoutMetadata);
    if (holder) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutMetadata', 'accountHolder'], message: holder });
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
  // La cuenta va siempre tapada: entera solo con «Ver cuenta para pagar»
  // (el dueño, con 2FA: POST /admin/operators/:id/payout-account/reveal).
  payoutMethod: PayoutMethodSchema.nullable().optional(),
  /** Tapada: IBAN "ES12 •••• •••• 1234", cripto "T…9f2a", email "a•••@dominio". */
  payoutAddressMasked: z.string().nullable().optional(),
  /** Banco, SWIFT y país (sin el titular: va tapado aparte). */
  payoutMetadata: PayoutMetadataSchema.nullable().optional(),
  /** Titular tapado («M••• L•••»). */
  payoutHolderMasked: z.string().nullable().optional(),
  /** El titular no se parece a su nombre: aviso para el dueño (no bloquea). */
  payoutHolderMismatch: z.boolean().optional(),
  payoutLabel: z.string().nullable().optional(),
  /** Última vez que cambió su cuenta de cobro (null: antes de guardarlo). */
  payoutAccountChangedAt: z.string().datetime().nullable().optional(),
  /** Cuenta cambiada hace menos de 48 h: hasta entonces no se le paga a ella (salvo en efectivo). */
  payoutHoldUntil: z.string().datetime().nullable().optional(),
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
  /** Huella de su foto de perfil (Mi perfil); null o ausente = sin foto. */
  photoHash: z.string().length(64).nullable().optional(),
});
export type OperatorPublicView = z.infer<typeof OperatorPublicViewSchema>;

/** Saldo agregado de la operadora — puede ser negativo si refunds > earnings. */
export const OperatorBalanceSchema = z.object({
  /** Todo lo no pagado, menos la deuda por devoluciones. */
  pendingCents: z.number().int(),
  /** Parte de pendingCents que ya entra en el próximo pago (pasados los días de espera). */
  availableCents: z.number().int(),
  /** Comisiones recientes aún en espera (sin las retenidas por el banco: van aparte). */
  heldCents: z.number().int().nonnegative(),
  /**
   * Ventas por datáfono sin cuadrar con el banco: su parte no se paga hasta
   * cuadrarlas o que el dueño las libere (bank-hold.ts). Opcional: API anterior.
   */
  bankHeldCents: z.number().int().nonnegative().optional(),
  /** Cuántas ventas por datáfono están retenidas. */
  bankHeldCount: z.number().int().nonnegative().optional(),
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
  /** Sin pagar y de una venta por datáfono sin cuadrar con el banco (retenida). */
  bankHeld: z.boolean().optional(),
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
  displayName: displayNameSchema(1, 80),
  /**
   * basis points (1500 = 15 %). Solo la fija el DUEÑO: si da de alta un
   * encargado se ignora y se aplica la del local. Sin ella, la del local.
   */
  commissionBps: z.number().int().min(0).max(10_000).optional().describe('basis points: 1500 = 15%'),
});
export type CreateOperatorDto = z.infer<typeof CreateOperatorSchema>;

export const UpdateOperatorSchema = z.object({
  displayName: displayNameSchema(1, 80).optional(),
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
  /** Código 2FA: lo pide el API al cambiar la cuenta de cobro (payout*) si el dueño la tiene activada. */
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
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
  /**
   * La cifra que vio quien paga: si lo pagable ya es otra (un cobro o una
   * devolución entre medias), 409 PAYOUT_CHANGED en vez de apuntar otra cosa.
   */
  expectedTotalCents: z.number().int().positive().optional(),
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
  /** Ventas por datáfono sin cuadrar con el banco: su parte no se paga hasta cuadrarlas. */
  bankHeldPayoutsCents: z.number().int().nonnegative().optional(),
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
// Es de un solo uso: al guardar deja de valer.

/**
 * 409 del enlace ya usado para guardar (GET y POST): la respuesta pudo
 * perderse; los datos están guardados y para cambiarlos hace falta otro enlace.
 */
export const SELF_ONBOARDING_ALREADY_SAVED = 'SELF_ONBOARDING_ALREADY_SAVED';

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
  /** Su cuenta, tapada: el enlace nunca la devuelve entera. */
  payoutAddressMasked: z.string().nullable().optional(),
  payoutLabel: z.string().nullable(),
  venueName: z.string(),
  /**
   * Si el formulario puede pedir la cuenta de cobro: solo con un enlace
   * generado por el dueño y si aún no tiene una (cambiarla, en el panel).
   */
  canSetPayout: z.boolean().optional(),
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
  /** Transferencia internacional (SWIFT): banco, SWIFT/BIC, titular y, si quiere, el país del banco. */
  payoutMetadata: PayoutMetadataSchema.nullable().optional(),
}).superRefine(refineSelfOnboardingPayout);
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
  /** Aviso para quien la dio de alta (p. ej. comisión ignorada a un encargado). */
  notice: z.string().optional(),
});
export type CreateOperatorResponse = z.infer<typeof CreateOperatorResponseSchema>;

// ─── «Ver cuenta para pagar» y el aviso a la compañera ───────────────
//   POST /admin/operators/:id/payout-account/reveal  { totpCode } → PayoutAccountFull (superadmin.ts)
//     Solo el dueño y con su 2FA; queda en el registro sin la cuenta en claro.
//   GET  /operators/me/payout-notice      → PayoutAccountNotice | null
//   POST /operators/me/payout-notice/seen → { ok: true }

export const RevealPayoutAccountSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras').optional(),
});
export type RevealPayoutAccountDto = z.infer<typeof RevealPayoutAccountSchema>;

/** «Tu cuenta de cobro ha cambiado»: lo ve la compañera al entrar en su app hasta que lo da por visto. */
export const PayoutAccountNoticeSchema = z.object({
  changedAt: z.string().datetime(),
  method: PayoutMethodSchema.nullable(),
  /** Tapada, como en «Ganancias»; null si no tiene (efectivo o la quitaron). */
  masked: z.string().nullable(),
});
export type PayoutAccountNotice = z.infer<typeof PayoutAccountNoticeSchema>;
