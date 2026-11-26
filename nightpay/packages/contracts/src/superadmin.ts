import { z } from 'zod';
import { ServiceFeeBpsSchema } from './service-fee';
import { RoleSchema } from './auth';
import { UuidSchema } from './common';
import {
  PayoutMetadataSchema,
  PayoutMethodSchema,
  isValidIban,
  payoutAddressProblem,
  payoutHolderProblem,
  type PayoutMethod,
} from './operators';
import { OperatorCommissionDefaultsSchema, type OperatorCommissionDefaults } from './payments';

// ═══════════════════════════════════════════════════════════════════════
// Consola del super-admin: /v1/superadmin/*
//
// Solo usuarios con users.isSuperAdmin (comprobado en la base en cada
// petición). Las escrituras que mueven dinero o identidades piden además el
// código 2FA del super-admin (`totpCode`, "step-up"): sin 2FA activada → 403
// TOTP_NOT_ENROLLED; sin código → 403 TOTP_REQUIRED; código malo → 403
// TOTP_INVALID; demasiados → 429 TOTP_LOCKED. Todo lo que cambia queda en
// audit_events (acciones `superadmin.*`, con antes/después y lo secreto tapado).
// Ver nightpay/docs/SUPERADMIN.md.
// ═══════════════════════════════════════════════════════════════════════

// ─── Piezas comunes ─────────────────────────────────────────────────────

/** Código de 6 cifras de la app de verificación del super-admin (acepta "123 456"). */
export const SuperAdminTotpCodeSchema = z
  .string()
  .max(20)
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras'));

/** Motivo de un cambio delicado (queda en el registro). */
export const SuperAdminReasonSchema = z.string().trim().min(3, 'Pon el motivo (mínimo 3 letras)').max(500);

/** Cuerpo de las acciones que solo piden el 2FA. */
export const StepUpSchema = z.object({ totpCode: SuperAdminTotpCodeSchema });
export type StepUpDto = z.infer<typeof StepUpSchema>;

/** Cuerpo de las acciones con 2FA y motivo obligatorio. */
export const StepUpWithReasonSchema = z.object({ totpCode: SuperAdminTotpCodeSchema, reason: SuperAdminReasonSchema });
export type StepUpWithReasonDto = z.infer<typeof StepUpWithReasonSchema>;

/** Motivo sin 2FA (acciones que protegen: bloquear un saldo, cerrar sesiones). */
export const ReasonOnlySchema = z.object({ reason: SuperAdminReasonSchema });
export type ReasonOnlyDto = z.infer<typeof ReasonOnlySchema>;

const IsoDate = z.string().datetime();
const BpsSchema = z.number().int().min(0).max(10_000);
/** Tope por cobro de una chica: hasta 10.000 € (el mismo que el de un cobro). */
export const MAX_OPERATOR_COBRO_CENTS = 10_000_00;
/** Días de espera para pagar a las chicas: 0 (al cierre de la noche) a 60. */
export const MAX_VENUE_PAYOUT_HOLD_DAYS = 60;
/** Umbral de aprobación de devoluciones por defecto (100 €). */
export const DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS = 100_00;

/** Paginación por cursor: `nextCursor` null = no hay más. */
export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// ─── Validadores y máscaras (puros: los usan el API y el panel) ─────────

/** IBAN como se guarda: sin espacios y en mayúsculas. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** IBAN válido (mod-97) tras normalizarlo. Reexporta la regla de las cuentas de cobro. */
export function isValidSettlementIban(raw: string): boolean {
  return isValidIban(normalizeIban(raw));
}

/** NIF/CIF/NIE como se guarda: mayúsculas, sin espacios, puntos ni guiones. */
export function normalizeTaxId(raw: string): string {
  return raw.replace(/[\s.-]+/g, '').toUpperCase();
}

const TAX_ID_RE = /^[A-Z0-9]{5,20}$/;

/** "ES91 2100 0418 4502 0005 1332" → "ES91 •••• •••• 1332". */
export function maskIban(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iban = normalizeIban(raw);
  if (iban.length < 8) return '••••';
  return `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}`;
}

/** Dirección cripto: "TXYZ…9f2a" → "T…9f2a"; "0x55d3…9955" → "0x…9955". */
export function maskWalletAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const a = raw.trim();
  if (a.length <= 6) return '••••';
  const head = a.toLowerCase().startsWith('0x') ? a.slice(0, 2) : a.slice(0, 1);
  return `${head}…${a.slice(-4)}`;
}

/** Email: "ana.lopez@gmail.com" → "a•••@gmail.com". */
export function maskEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const [user, domain] = raw.trim().split('@');
  if (!user || !domain) return '••••';
  return `${user.slice(0, 1)}•••@${domain}`;
}

const CRYPTO_METHODS: ReadonlySet<PayoutMethod> = new Set<PayoutMethod>(['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL']);
const IBAN_METHODS: ReadonlySet<PayoutMethod> = new Set<PayoutMethod>(['SEPA_IBAN', 'WIRE_INTERNATIONAL']);
const EMAIL_METHODS: ReadonlySet<PayoutMethod> = new Set<PayoutMethod>(['FASTERPAY_EMAIL', 'PAYQUICKER_EMAIL', 'PAYONEER_EMAIL']);

/** Cuenta de cobro tapada según el método (IBAN, cripto, email o lo demás: "•••1234"). */
export function maskPayoutAddress(method: PayoutMethod | string | null | undefined, address: string | null | undefined): string | null {
  if (!address) return null;
  const m = method as PayoutMethod;
  if (IBAN_METHODS.has(m)) return maskIban(address);
  if (CRYPTO_METHODS.has(m)) return maskWalletAddress(address);
  if (EMAIL_METHODS.has(m) || address.includes('@')) return maskEmail(address);
  const a = address.trim();
  return a.length <= 4 ? '••••' : `•••${a.slice(-4)}`;
}

/**
 * Comisiones de un local: para cada categoría, lo de la chica (o del
 * personal) + lo de la plataforma no puede pasar del 100 %. Con
 * `maxOperatorOverrideBps` (el % propio más alto de una chica del local),
 * también para su servicio. null si cuadra; si no, el motivo.
 */
export function commissionTotalsProblem(input: {
  platformCommissionBps: number;
  operatorCommissionDefaults: Partial<OperatorCommissionDefaults>;
  maxOperatorOverrideBps?: number | null;
}): string | null {
  const platform = input.platformCommissionBps;
  for (const [category, bps] of Object.entries(input.operatorCommissionDefaults)) {
    if (typeof bps === 'number' && bps + platform > 10_000) {
      return `La comisión de ${category} (${pct(bps)}) más la de la plataforma (${pct(platform)}) pasa del 100 %`;
    }
  }
  const override = input.maxOperatorOverrideBps;
  if (typeof override === 'number' && override + platform > 10_000) {
    return `Hay una chica con ${pct(override)} propio: con la plataforma al ${pct(platform)} pasaría del 100 %`;
  }
  return null;
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, '').replace('.', ',')} %`;
}

/** Zona horaria IANA que conoce el servidor ("Europe/Madrid"). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Vista general ─────────────────────────────────────────────────────
//   GET /v1/superadmin/overview → SuperAdminOverview

export const VenuePauseScopeSchema = z.enum(['venue', 'business']);
export type VenuePauseScopeValue = z.infer<typeof VenuePauseScopeSchema>;

export const OverviewVenueSchema = z.object({
  venueId: UuidSchema,
  name: z.string(),
  slug: z.string(),
  businessId: UuidSchema.nullable(),
  /** No acepta cobros nuevos (el local o su negocio en pausa). */
  paused: z.boolean(),
  pausedBy: VenuePauseScopeSchema.nullable(),
  /** Cobrado (importe + propinas) hoy, día de Madrid desde las 00:00. */
  chargedTodayCents: z.number().int(),
  paymentsToday: z.number().int().nonnegative(),
  /** Cobrado hoy y los 7 días anteriores (como las métricas del panel). */
  chargedWeekCents: z.number().int(),
  /** A pagar ya a las chicas (con los días de espera del local), como Tesorería. */
  pendingToChicasCents: z.number().int(),
  /** Comisiones aún en espera. */
  heldForChicasCents: z.number().int(),
  /** Ventas por datáfono sin cuadrar con el banco: su parte no se paga hasta cuadrarlas. Opcional: API anterior. */
  bankHeldForChicasCents: z.number().int().optional(),
  /** Deuda de las chicas por devoluciones tras un pago. */
  chicasDebtCents: z.number().int(),
  /** Saldo vivo de clientes cargado en este local (ACTIVE). */
  liveCustomerBalanceCents: z.number().int(),
  liveCustomerWallets: z.number().int().nonnegative(),
  /** Incidencias abiertas (la bandeja del local, sin los avisos de copias). */
  openIncidents: z.number().int().nonnegative(),
  payoutHoldDays: z.number().int(),
  /** «Comisión del servicio al cliente» encendida en el local. Opcional: API anterior. */
  serviceFeeEnabled: z.boolean().optional(),
  /** La comisión del servicio de hoy y los 7 días anteriores que se debe a OxioPay (cobrada − devuelta). */
  serviceFeeWeekCents: z.number().int().optional(),
});
export type OverviewVenue = z.infer<typeof OverviewVenueSchema>;

export const OverviewTotalsSchema = z.object({
  chargedTodayCents: z.number().int(),
  paymentsToday: z.number().int(),
  chargedWeekCents: z.number().int(),
  pendingToChicasCents: z.number().int(),
  heldForChicasCents: z.number().int(),
  bankHeldForChicasCents: z.number().int().optional(),
  chicasDebtCents: z.number().int(),
  liveCustomerBalanceCents: z.number().int(),
  liveCustomerWallets: z.number().int(),
  openIncidents: z.number().int(),
  venues: z.number().int(),
  pausedVenues: z.number().int(),
  /** «Comisión del servicio» de la semana que se debe a OxioPay. Opcional: API anterior. */
  serviceFeeWeekCents: z.number().int().optional(),
});
export type OverviewTotals = z.infer<typeof OverviewTotalsSchema>;

export const OverviewBusinessSchema = z.object({
  /** null = locales sin negocio asignado. */
  businessId: UuidSchema.nullable(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'PAUSED']).nullable(),
  totals: OverviewTotalsSchema,
  venues: z.array(OverviewVenueSchema),
});
export type OverviewBusiness = z.infer<typeof OverviewBusinessSchema>;

export const SuperAdminOverviewSchema = z.object({
  generatedAt: IsoDate,
  /** Inicio de "hoy" y de "la semana" (hora de Madrid). */
  todayFrom: IsoDate,
  weekFrom: IsoDate,
  totals: OverviewTotalsSchema,
  businesses: z.array(OverviewBusinessSchema),
});
export type SuperAdminOverview = z.infer<typeof SuperAdminOverviewSchema>;

// ─── Negocios (clientes de OxioPay) ─────────────────────────────────────
//   GET   /v1/superadmin/businesses?q=&status=        → BusinessView[]
//   GET   /v1/superadmin/businesses/:id               → BusinessDetail
//   POST  /v1/superadmin/businesses                   CreateBusinessRequest (2FA con comisión) → BusinessView
//   PATCH /v1/superadmin/businesses/:id               UpdateBusinessDto (2FA si cambia la comisión) → BusinessView
//   POST  /v1/superadmin/businesses/:id/pause         PauseDto (2FA) → BusinessView
//   POST  /v1/superadmin/businesses/:id/resume        ResumeDto (2FA) → BusinessView
//   POST  /v1/superadmin/businesses/:id/venues        AssignVenuesDto (2FA) → BusinessDetail
//   POST  /v1/superadmin/businesses/:id/venues/:venueId/unassign  UnassignVenueDto (2FA) → BusinessDetail

export const BusinessStatusSchema = z.enum(['ACTIVE', 'PAUSED']);
export type BusinessStatusValue = z.infer<typeof BusinessStatusSchema>;

const TaxIdSchema = z
  .string()
  .transform(normalizeTaxId)
  .pipe(z.string().regex(TAX_ID_RE, 'NIF/CIF: de 5 a 20 letras o números'));

const BusinessFields = {
  name: z.string().trim().min(2).max(160),
  taxId: TaxIdSchema.nullable(),
  contactName: z.string().trim().max(120).nullable(),
  contactEmail: z.string().trim().email().max(254).nullable(),
  contactPhone: z.string().trim().max(40).nullable(),
  notes: z.string().max(4000).nullable(),
  defaultPlatformCommissionBps: BpsSchema.nullable(),
  /** «Comisión del servicio» de sus locales nuevos (pagos con tarjeta / recargas). null = la de fábrica (10 %). */
  defaultServiceFeeBps: ServiceFeeBpsSchema.nullable(),
  defaultTopUpServiceFeeBps: ServiceFeeBpsSchema.nullable(),
};

export const CreateBusinessSchema = z.object({
  name: BusinessFields.name,
  taxId: BusinessFields.taxId.optional(),
  contactName: BusinessFields.contactName.optional(),
  contactEmail: BusinessFields.contactEmail.optional(),
  contactPhone: BusinessFields.contactPhone.optional(),
  notes: BusinessFields.notes.optional(),
  defaultPlatformCommissionBps: BusinessFields.defaultPlatformCommissionBps.optional(),
  defaultServiceFeeBps: BusinessFields.defaultServiceFeeBps.optional(),
  defaultTopUpServiceFeeBps: BusinessFields.defaultTopUpServiceFeeBps.optional(),
});
export type CreateBusinessDto = z.infer<typeof CreateBusinessSchema>;

/** Cuerpo del alta: con una comisión por defecto propia hace falta `totpCode`. */
export const CreateBusinessRequestSchema = CreateBusinessSchema.extend({ totpCode: SuperAdminTotpCodeSchema.optional() });
export type CreateBusinessRequest = z.infer<typeof CreateBusinessRequestSchema>;

/** Cambiar `defaultPlatformCommissionBps` (a otro valor) pide `totpCode`. */
export const UpdateBusinessSchema = CreateBusinessSchema.partial()
  .extend({ totpCode: SuperAdminTotpCodeSchema.optional() })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'totpCode' && x !== undefined), 'No hay nada que cambiar');
export type UpdateBusinessDto = z.infer<typeof UpdateBusinessSchema>;

export const PauseSchema = z.object({ reason: SuperAdminReasonSchema, totpCode: SuperAdminTotpCodeSchema });
export type PauseDto = z.infer<typeof PauseSchema>;

/** Quitar la pausa: 2FA y, si quieres, el motivo. */
export const ResumeSchema = z.object({ totpCode: SuperAdminTotpCodeSchema, reason: SuperAdminReasonSchema.optional() });
export type ResumeDto = z.infer<typeof ResumeSchema>;

/** Meter locales en un negocio (2FA: puede sacarlos de uno en pausa). */
export const AssignVenuesSchema = z.object({
  venueIds: z.array(UuidSchema).min(1).max(100),
  totpCode: SuperAdminTotpCodeSchema.optional(),
});
export type AssignVenuesDto = z.infer<typeof AssignVenuesSchema>;

/** Sacar un local de su negocio (2FA: si el negocio está en pausa, el local vuelve a cobrar). */
export const UnassignVenueSchema = z.object({ totpCode: SuperAdminTotpCodeSchema.optional() });
export type UnassignVenueDto = z.infer<typeof UnassignVenueSchema>;

export const BusinessListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: BusinessStatusSchema.optional(),
});
export type BusinessListQuery = z.infer<typeof BusinessListQuerySchema>;

export const BusinessViewSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  taxId: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  status: BusinessStatusSchema,
  pausedAt: IsoDate.nullable(),
  pausedReason: z.string().nullable(),
  defaultPlatformCommissionBps: z.number().int().nullable(),
  /** «Comisión del servicio» por defecto de sus locales nuevos (null = la de fábrica). Opcional: API anterior. */
  defaultServiceFeeBps: z.number().int().nullable().optional(),
  defaultTopUpServiceFeeBps: z.number().int().nullable().optional(),
  venueCount: z.number().int().nonnegative(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type BusinessView = z.infer<typeof BusinessViewSchema>;

// ─── Locales ────────────────────────────────────────────────────────────
//   GET   /v1/superadmin/venues?q=&businessId=&paused=   → VenueListItem[]
//   GET   /v1/superadmin/venues/:id                     → VenueDetail
//   POST  /v1/superadmin/venues                         CreateVenueDto → VenueDetail
//   PATCH /v1/superadmin/venues/:id/profile             UpdateVenueProfileDto → VenueDetail
//   PATCH /v1/superadmin/venues/:id/rules               UpdateVenueRulesDto (2FA) → VenueDetail
//   PUT   /v1/superadmin/venues/:id/settlement-account  SetSettlementAccountDto (2FA) → VenueDetail
//   POST  /v1/superadmin/venues/:id/settlement-account/clear  StepUpWithReasonDto (2FA) → VenueDetail
//   POST  /v1/superadmin/venues/:id/pause               PauseDto (2FA) → VenueDetail
//   POST  /v1/superadmin/venues/:id/resume              ResumeDto (2FA) → VenueDetail

export const VatRegimeSchema = z.enum(['GENERAL', 'RECARGO_EQUIVALENCIA', 'EXENTO']);

const SlugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug en minúsculas con guiones (ej. luna-vlc)');
const TimeZoneSchema = z.string().max(60).refine(isValidTimeZone, 'Zona horaria desconocida (ej. Europe/Madrid)');
/** Grupo de locales que comparten el saldo de los clientes (mismo dueño). */
const WalletGroupSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Grupo del saldo: minúsculas, números, guion o guion bajo');

export const VenueListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  businessId: UuidSchema.optional(),
  /** "true" = solo en pausa; "false" = solo activos. */
  paused: z.enum(['true', 'false']).optional(),
});
export type VenueListQuery = z.infer<typeof VenueListQuerySchema>;

export const CreateVenueSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: SlugSchema,
  timezone: TimeZoneSchema.optional(),
  businessId: UuidSchema.optional(),
  walletGroup: WalletGroupSchema.nullable().optional(),
  /** Sin ella: la del negocio (defaultPlatformCommissionBps) o la general (10 %). */
  platformCommissionBps: BpsSchema.optional(),
  /** Con `walletGroup` o `platformCommissionBps` hace falta (como en el perfil y las reglas). */
  totpCode: SuperAdminTotpCodeSchema.optional(),
});
export type CreateVenueDto = z.infer<typeof CreateVenueSchema>;

/**
 * Perfil del local. walletGroup, vatBps y vatRegime cambian dinero/impuestos:
 * con cualquiera de ellos hace falta `totpCode`.
 */
export const UpdateVenueProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    timezone: TimeZoneSchema.optional(),
    vatBps: z.number().int().min(0).max(10_000).optional(),
    vatRegime: VatRegimeSchema.optional(),
    walletGroup: WalletGroupSchema.nullable().optional(),
    totpCode: SuperAdminTotpCodeSchema.optional(),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'totpCode' && x !== undefined), 'No hay nada que cambiar');
export type UpdateVenueProfileDto = z.infer<typeof UpdateVenueProfileSchema>;

/** Campos del perfil que piden 2FA. */
export const VENUE_PROFILE_STEP_UP_FIELDS = ['walletGroup', 'vatBps', 'vatRegime'] as const;

// Altas y negocios que piden 2FA (los mismos en el API y en el panel).

/** Alta de local con grupo del saldo o comisión propia (como cambiarlos después). */
export function venueCreateNeedsStepUp(dto: Pick<CreateVenueDto, 'walletGroup' | 'platformCommissionBps'>): boolean {
  return Boolean(dto.walletGroup) || dto.platformCommissionBps !== undefined;
}

/** Lo del negocio que es dinero (sus comisiones por defecto): ponerlo o cambiarlo pide 2FA. */
const BUSINESS_MONEY_FIELDS = ['defaultPlatformCommissionBps', 'defaultServiceFeeBps', 'defaultTopUpServiceFeeBps'] as const;
type BusinessMoneyField = (typeof BUSINESS_MONEY_FIELDS)[number];

/** Alta de negocio con comisión por defecto propia (la de la plataforma o la del servicio). */
export function businessCreateNeedsStepUp(dto: Partial<Pick<CreateBusinessDto, BusinessMoneyField>>): boolean {
  return BUSINESS_MONEY_FIELDS.some((k) => dto[k] !== undefined && dto[k] !== null);
}

/** Cambiar una comisión por defecto del negocio (a otro valor); reenviar la misma, no. */
export function businessUpdateNeedsStepUp(
  dto: Partial<Pick<UpdateBusinessDto, BusinessMoneyField>>,
  current: { defaultPlatformCommissionBps: number | null } & Partial<Record<Exclude<BusinessMoneyField, 'defaultPlatformCommissionBps'>, number | null>>,
): boolean {
  return BUSINESS_MONEY_FIELDS.some((k) => dto[k] !== undefined && dto[k] !== (current[k] ?? null));
}

/**
 * Reglas del local (siempre con 2FA). Las comisiones por categoría llegan
 * parciales: las que faltan se quedan como están. Además de los rangos, la
 * suma chica + plataforma de cada categoría no puede pasar del 100 %
 * (commissionTotalsProblem, con lo ya guardado).
 */
export const UpdateVenueRulesSchema = z
  .object({
    operatorMaxCobroCents: z.number().int().min(0).max(MAX_OPERATOR_COBRO_CENTS).optional(),
    platformCommissionBps: BpsSchema.optional(),
    operatorCommissionDefaults: OperatorCommissionDefaultsSchema.partial().optional(),
    /** null = el del entorno (PAYOUT_HOLD_DAYS). 0 = se paga al cierre de la noche. */
    payoutHoldDays: z.number().int().min(0).max(MAX_VENUE_PAYOUT_HOLD_DAYS).nullable().optional(),
    refundApprovalThresholdCents: z.number().int().min(0).max(MAX_OPERATOR_COBRO_CENTS).optional(),
    payoutRequiresApproval: z.boolean().optional(),
    /**
     * «Comisión del servicio al cliente» (service-fee.ts): el interruptor
     * (apagado de fábrica; encendido, el cliente paga encima y el local deja
     * de pagar el % antiguo) y los dos %, de 0 a 12 %.
     */
    serviceFeeEnabled: z.boolean().optional(),
    serviceFeeBps: ServiceFeeBpsSchema.optional(),
    topUpServiceFeeBps: ServiceFeeBpsSchema.optional(),
    /** Las compañeras cobran desde su móvil (apagada: cobra el encargado a su nombre). */
    operatorsChargeFromPhone: z.boolean().optional(),
    totpCode: SuperAdminTotpCodeSchema,
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'totpCode' && x !== undefined), 'No hay nada que cambiar');
export type UpdateVenueRulesDto = z.infer<typeof UpdateVenueRulesSchema>;

export const SetSettlementAccountSchema = z.object({
  iban: z
    .string()
    .max(50)
    .transform(normalizeIban)
    .refine(isValidIban, 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra)'),
  holder: z.string().trim().min(2).max(160),
  totpCode: SuperAdminTotpCodeSchema,
});
export type SetSettlementAccountDto = z.infer<typeof SetSettlementAccountSchema>;

export const VenueRulesSchema = z.object({
  operatorMaxCobroCents: z.number().int(),
  platformCommissionBps: z.number().int(),
  operatorCommissionDefaults: OperatorCommissionDefaultsSchema,
  /** Lo guardado (null = el del entorno). */
  payoutHoldDays: z.number().int().nullable(),
  /** Lo que se aplica hoy (el del local o PAYOUT_HOLD_DAYS). */
  effectivePayoutHoldDays: z.number().int(),
  refundApprovalThresholdCents: z.number().int(),
  payoutRequiresApproval: z.boolean(),
  /** «Comisión del servicio al cliente»: el interruptor y los dos %. Opcional: API anterior (apagada). */
  serviceFeeEnabled: z.boolean().optional(),
  serviceFeeBps: z.number().int().optional(),
  topUpServiceFeeBps: z.number().int().optional(),
  /** Por qué no se puede encender en este local (su pasarela no podría cobrarla); null: se puede. */
  serviceFeeBlockedReason: z.string().nullable().optional(),
  /** «Las compañeras cobran desde su móvil». Opcional: API anterior (encendida). */
  operatorsChargeFromPhone: z.boolean().optional(),
});
export type VenueRules = z.infer<typeof VenueRulesSchema>;

export const VenueListItemSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  walletGroup: z.string().nullable(),
  business: z.object({ id: UuidSchema, name: z.string(), status: BusinessStatusSchema }).nullable(),
  paused: z.boolean(),
  pausedBy: VenuePauseScopeSchema.nullable(),
  pausedAt: IsoDate.nullable(),
  pausedReason: z.string().nullable(),
  settlementIbanMasked: z.string().nullable(),
  createdAt: IsoDate,
});
export type VenueListItem = z.infer<typeof VenueListItemSchema>;

export const VenueDetailSchema = VenueListItemSchema.extend({
  vatBps: z.number().int(),
  vatRegime: z.string(),
  /** IBAN completo (el de la empresa, no es dato personal) y titular. */
  settlementIban: z.string().nullable(),
  settlementHolder: z.string().nullable(),
  rules: VenueRulesSchema,
  counts: z.object({ users: z.number().int(), operators: z.number().int(), terminals: z.number().int() }),
});
export type VenueDetail = z.infer<typeof VenueDetailSchema>;

/** Negocio con sus locales (GET /businesses/:id y las asignaciones). */
export const BusinessDetailSchema = BusinessViewSchema.extend({ venues: z.array(VenueListItemSchema) });
export type BusinessDetail = z.infer<typeof BusinessDetailSchema>;

// ─── Personal y administradores (todos los locales) ─────────────────────
//   GET  /v1/superadmin/users?venueId=&role=&q=&active=&superAdmin=&cursor=&limit= → page de StaffUserView
//   GET  /v1/superadmin/users/:id                       → StaffUserView
//   POST /v1/superadmin/users                           CreateStaffUserDto (2FA) → CreateStaffUserResponse
//   POST /v1/superadmin/users/:id/reset-password        StepUpWithReasonDto (2FA) → ResetStaffPasswordResponse
//   POST /v1/superadmin/users/:id/disable               StepUpWithReasonDto (2FA) → StaffUserView
//   POST /v1/superadmin/users/:id/enable                StepUpWithReasonDto (2FA) → StaffUserView
//   POST /v1/superadmin/users/:id/revoke-sessions       ReasonOnlyDto → { revoked }
//   POST /v1/superadmin/users/:id/totp/reset            StepUpWithReasonDto (2FA) → StaffUserView
//   POST /v1/superadmin/users/:id/super-admin           SetSuperAdminDto (2FA) → StaffUserView

const BooleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const StaffListQuerySchema = z.object({
  venueId: UuidSchema.optional(),
  role: RoleSchema.optional(),
  q: z.string().trim().max(120).optional(),
  active: BooleanQuery.optional(),
  superAdmin: BooleanQuery.optional(),
  cursor: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type StaffListQuery = z.infer<typeof StaffListQuerySchema>;

export const StaffUserViewSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  role: RoleSchema,
  venue: z.object({ id: UuidSchema, name: z.string(), slug: z.string() }),
  /** false = dado de baja (no entra). */
  active: z.boolean(),
  /** Invitación enviada y aún sin contraseña. */
  invitePending: z.boolean(),
  totpEnabled: z.boolean(),
  isSuperAdmin: z.boolean(),
  /** Último login correcto (del registro); null = nunca o antes del registro. */
  lastLoginAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type StaffUserView = z.infer<typeof StaffUserViewSchema>;

export const StaffUserPageSchema = pageOf(StaffUserViewSchema);
export type StaffUserPage = z.infer<typeof StaffUserPageSchema>;

export const CreateStaffUserSchema = z
  .object({
    venueId: UuidSchema,
    role: RoleSchema,
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: z.string().trim().min(1).max(80).optional(),
    /** Solo OPERATOR: su % propio del servicio (sin él, el del local). */
    commissionBps: BpsSchema.optional(),
    totpCode: SuperAdminTotpCodeSchema,
  })
  .refine((v) => v.role === 'OPERATOR' || v.commissionBps === undefined, {
    message: 'La comisión propia solo es para chicas (OPERATOR)',
    path: ['commissionBps'],
  })
  .refine((v) => v.role !== 'OPERATOR' || Boolean(v.displayName), {
    message: 'Pon el nombre con el que se verá a la chica',
    path: ['displayName'],
  });
export type CreateStaffUserDto = z.infer<typeof CreateStaffUserSchema>;

/** Alta: nunca se devuelve una contraseña; enlace de invitación (24 h) para que la ponga. */
export const CreateStaffUserResponseSchema = z.object({
  user: StaffUserViewSchema,
  inviteUrl: z.string().url(),
  expiresAt: IsoDate,
  /** Si salió el email con el enlace (si no, mándalo por WhatsApp). */
  emailSent: z.boolean(),
});
export type CreateStaffUserResponse = z.infer<typeof CreateStaffUserResponseSchema>;

/**
 * Como el reset de la chica de hoy: si aún no activó la cuenta, enlace de
 * invitación nuevo; si ya la activó, contraseña temporal que se ve UNA vez
 * (no se guarda en claro). En los dos casos se cierran sus sesiones.
 */
export const ResetStaffPasswordResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invite'), inviteUrl: z.string().url(), expiresAt: IsoDate, revokedSessions: z.number().int() }),
  z.object({ kind: z.literal('password'), password: z.string(), revokedSessions: z.number().int() }),
]);
export type ResetStaffPasswordResponse = z.infer<typeof ResetStaffPasswordResponseSchema>;

export const SetSuperAdminSchema = z.object({
  enabled: z.boolean(),
  reason: SuperAdminReasonSchema,
  totpCode: SuperAdminTotpCodeSchema,
});
export type SetSuperAdminDto = z.infer<typeof SetSuperAdminSchema>;

export const RevokeSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponseSchema>;

// ─── Cuentas de cobro de las chicas (todos los locales) ─────────────────
//   GET  /v1/superadmin/payout-accounts?venueId=&method=&q=&missing=  → PayoutAccountListItem[]
//   POST /v1/superadmin/payout-accounts/:userId/reveal   StepUpWithReasonDto (2FA) → PayoutAccountFull
//   PUT  /v1/superadmin/payout-accounts/:userId          UpdatePayoutAccountDto (2FA) → PayoutAccountListItem

export const PayoutAccountListQuerySchema = z.object({
  venueId: UuidSchema.optional(),
  method: PayoutMethodSchema.optional(),
  q: z.string().trim().max(120).optional(),
  /** "true" = solo las que no tienen cuenta. */
  missing: BooleanQuery.optional(),
  /** Por defecto solo las activas. */
  includeInactive: BooleanQuery.optional(),
});
export type PayoutAccountListQuery = z.infer<typeof PayoutAccountListQuerySchema>;

export const PayoutAccountListItemSchema = z.object({
  userId: UuidSchema,
  displayName: z.string().nullable(),
  email: z.string(),
  venue: z.object({ id: UuidSchema, name: z.string() }),
  active: z.boolean(),
  payoutMethod: PayoutMethodSchema.nullable(),
  /** Tapada: IBAN "ES12 •••• •••• 1234", cripto "T…9f2a", email "a•••@dominio". */
  payoutAddressMasked: z.string().nullable(),
  /** Titular tapado («M••• L•••»), en SEPA y SWIFT. Opcional: API anterior. */
  payoutHolderMasked: z.string().nullable().optional(),
  payoutLabel: z.string().nullable(),
  hasPayoutAccount: z.boolean(),
  updatedAt: IsoDate,
});
export type PayoutAccountListItem = z.infer<typeof PayoutAccountListItemSchema>;

export const PayoutAccountFullSchema = z.object({
  userId: UuidSchema,
  payoutMethod: PayoutMethodSchema.nullable(),
  payoutAddress: z.string().nullable(),
  payoutLabel: z.string().nullable(),
  payoutMetadata: PayoutMetadataSchema.nullable(),
});
export type PayoutAccountFull = z.infer<typeof PayoutAccountFullSchema>;

/**
 * Cambiar la cuenta de cobro de una chica: método y dirección juntos
 * (validada según el método: TRC20, EVM, Solana, IBAN mod-97, email) o los
 * dos a null para quitarla. Motivo y 2FA obligatorios.
 */
export const UpdatePayoutAccountSchema = z
  .object({
    payoutMethod: PayoutMethodSchema.nullable(),
    payoutAddress: z.string().trim().min(1).max(200).nullable(),
    payoutLabel: z.string().trim().max(120).nullable().optional(),
    payoutMetadata: PayoutMetadataSchema.nullable().optional(),
    reason: SuperAdminReasonSchema,
    totpCode: SuperAdminTotpCodeSchema,
  })
  .superRefine((v, ctx) => {
    if ((v.payoutMethod === null) !== (v.payoutAddress === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payoutAddress'],
        message: 'Método y cuenta van juntos (o los dos vacíos para quitarla)',
      });
      return;
    }
    const problem = payoutAddressProblem(v.payoutMethod, v.payoutAddress);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutAddress'], message: problem });
    // En SEPA y SWIFT, el titular (el banco lo pide).
    const holder = payoutHolderProblem(v.payoutMethod, v.payoutMetadata);
    if (holder) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutMetadata', 'accountHolder'], message: holder });
  });
export type UpdatePayoutAccountDto = z.infer<typeof UpdatePayoutAccountSchema>;

// ─── Clientes con saldo (todos los locales) ─────────────────────────────
//   GET  /v1/superadmin/customers/search?q=             → CustomerSearchResult[]
//   GET  /v1/superadmin/customers/:walletId             → CustomerWalletDetail
//   POST /v1/superadmin/customers/:walletId/block       ReasonOnlyDto → CustomerWalletDetail
//   POST /v1/superadmin/customers/:walletId/unblock     StepUpWithReasonDto (2FA) → CustomerWalletDetail
//   POST /v1/superadmin/customers/:walletId/unlock-pin  StepUpWithReasonDto (2FA) → CustomerWalletDetail
//   POST /v1/superadmin/customers/:walletId/relink      StepUpWithReasonDto (2FA) → { path }

export const CustomerSearchQuerySchema = z.object({
  /** Código del cliente (K7Q-4M2), ficha NFC (código o número de serie), id del saldo o id de un cobro. */
  q: z.string().trim().min(3).max(200),
});
export type CustomerSearchQuery = z.infer<typeof CustomerSearchQuerySchema>;

export const CustomerMatchKindSchema = z.enum(['shortCode', 'cardToken', 'cardUid', 'walletId', 'paymentId']);

export const WalletStatusValueSchema = z.enum(['ACTIVE', 'EXPIRED', 'REFUNDED', 'DEPLETED']);

export const CustomerSearchResultSchema = z.object({
  walletId: UuidSchema,
  code: z.string().nullable(),
  status: WalletStatusValueSchema,
  balanceCents: z.number().int(),
  walletGroup: z.string().nullable(),
  homeVenue: z.object({ id: UuidSchema, name: z.string() }),
  blocked: z.boolean(),
  matchedBy: CustomerMatchKindSchema,
  createdAt: IsoDate,
});
export type CustomerSearchResult = z.infer<typeof CustomerSearchResultSchema>;

export const CustomerMovementSchema = z.object({
  kind: z.enum(['topup', 'consumption', 'payout']),
  id: UuidSchema,
  /** + entra en el saldo, − sale. */
  amountCents: z.number().int(),
  status: z.string(),
  label: z.string(),
  venue: z.object({ id: UuidSchema, name: z.string() }),
  at: IsoDate,
});
export type CustomerMovement = z.infer<typeof CustomerMovementSchema>;

export const CustomerWalletDetailSchema = z.object({
  walletId: UuidSchema,
  code: z.string().nullable(),
  label: z.string().nullable(),
  status: WalletStatusValueSchema,
  balanceCents: z.number().int(),
  walletGroup: z.string().nullable(),
  homeVenue: z.object({ id: UuidSchema, name: z.string() }),
  blocked: z.boolean(),
  blockedAt: IsoDate.nullable(),
  blockedReason: z.string().nullable(),
  closeRequestedAt: IsoDate.nullable(),
  /** Recarga sumada a otro saldo: el del cliente es ese. */
  mergedIntoId: UuidSchema.nullable(),
  passkeysCount: z.number().int().nonnegative(),
  cards: z.object({ active: z.number().int(), blocked: z.number().int() }),
  pin: z.object({ hasPin: z.boolean(), locked: z.boolean(), fails: z.number().int() }),
  createdAt: IsoDate,
  /** Últimos movimientos (recargas, consumos, devoluciones), el más reciente primero. */
  movements: z.array(CustomerMovementSchema),
});
export type CustomerWalletDetail = z.infer<typeof CustomerWalletDetailSchema>;

export const RelinkResponseSchema = z.object({
  /**
   * QR de activación de un solo uso del enlace nuevo, relativo a la API
   * ("/w/a/<token>", 10 min, M-2): con él el cliente activa Face ID (o elige
   * su PIN) en su móvil y su móvil sigue a su saldo. El enlace permanente
   * nuevo (/w/<qrToken>) no sale nunca en la pantalla del personal.
   */
  path: z.string(),
  removedPasskeys: z.number().int().nonnegative().optional(),
});
export type RelinkResponse = z.infer<typeof RelinkResponseSchema>;

// ─── Registro (audit_events de todos los locales) ───────────────────────
//   GET /v1/superadmin/audit?venueId=&actorId=&action=&from=&to=&cursor=&limit= → page de AuditEventView

export const AuditListQuerySchema = z.object({
  venueId: UuidSchema.optional(),
  actorId: UuidSchema.optional(),
  /** Prefijo de la acción: "superadmin.", "auth.login", "refund."… */
  action: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9_.]+$/i, 'Acción: letras, números, punto y guion bajo')
    .optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  /** id del último de la página anterior. Hasta 18 cifras: con 19 puede pasarse del bigint de la columna (500). */
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditEventViewSchema = z.object({
  id: z.string(),
  occurredAt: IsoDate,
  action: z.string(),
  venue: z.object({ id: UuidSchema, name: z.string() }).nullable(),
  actorId: UuidSchema.nullable(),
  actorEmail: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  /** Con contraseñas, tokens y secretos tapados; IBAN y direcciones, enmascarados. */
  payload: z.unknown().nullable(),
  ip: z.string().nullable(),
  traceId: z.string().nullable(),
});
export type AuditEventView = z.infer<typeof AuditEventViewSchema>;

export const AuditEventPageSchema = pageOf(AuditEventViewSchema);
export type AuditEventPage = z.infer<typeof AuditEventPageSchema>;

// ─── Yavin por local (enlace de pago con QR) ─────────────────────────────
// Solo con YAVIN_ENABLED en el servidor (si no, 404). La clave de API nunca
// vuelve: solo si está puesta y desde cuándo.
//   GET  /v1/superadmin/venues/:id/yavin          → YavinVenueStatus
//   PUT  /v1/superadmin/venues/:id/yavin/key      SetYavinKeyDto (2FA) → YavinVenueStatus
//   POST /v1/superadmin/venues/:id/yavin/use      SetYavinUseDto (2FA) → YavinVenueStatus
//   POST /v1/superadmin/venues/:id/yavin/clear    StepUpWithReasonDto (2FA) → YavinVenueStatus

export const YavinVenueStatusSchema = z.object({
  /** Hay una clave de API de Yavin guardada (cifrada) y activa. */
  configured: z.boolean(),
  savedAt: IsoDate.nullable(),
  /** El super-admin eligió usar Yavin en este local. */
  selected: z.boolean(),
  /** Yavin cobra en este local (clave + elegido + servidor encendido). */
  inUse: z.boolean(),
  /** La pasarela de siempre del local (BBVA/Redsys); null = no tiene. */
  baseGateway: z.string().nullable(),
});
export type YavinVenueStatus = z.infer<typeof YavinVenueStatusSchema>;

export const SetYavinKeySchema = z.object({
  apiKey: z.string().trim().min(8, 'La clave de Yavin es más larga').max(300).regex(/^\S+$/, 'La clave no lleva espacios'),
  totpCode: SuperAdminTotpCodeSchema,
});
export type SetYavinKeyDto = z.infer<typeof SetYavinKeySchema>;

export const SetYavinUseSchema = z.object({ use: z.boolean(), totpCode: SuperAdminTotpCodeSchema });
export type SetYavinUseDto = z.infer<typeof SetYavinUseSchema>;
