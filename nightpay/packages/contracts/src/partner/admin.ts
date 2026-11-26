import { z } from 'zod';
import { UuidSchema } from '../common';
import { SuperAdminReasonSchema, SuperAdminTotpCodeSchema } from '../superadmin';
import {
  EEA_COUNTRIES,
  PARTNER_SCOPES,
  PartnerScopeSchema,
  cleanPartnerText,
  partnerTextProblem,
  LOAD_CAPS,
  type PartnerKeyMode,
  type PartnerScope,
} from './common';

// Gestión de las conexiones con otras plataformas: el dueño
// (/v1/admin/partner-connections) y la consola del super-admin
// (/v1/superadmin/partners). Cuerpos estrictos: un campo de más, 400.

const OwnerTotpSchema = z
  .string()
  .max(20)
  .transform((s) => s.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras'))
  .optional();

/** Lista de permisos sin repetidos. */
const ScopeSetSchema = z
  .array(PartnerScopeSchema)
  .min(1)
  .max(PARTNER_SCOPES.length)
  .refine((s) => new Set(s).size === s.length, 'Sin permisos repetidos');

/** Una IP o red tal cual la escriben (la valida el API: partner-ip.ts). */
const IpEntrySchema = z.string().trim().min(2).max(64);

/** Caducidad de la clave: fecha con zona, o null (sin caducidad: solo sin permisos de dinero). */
const KeyExpirySchema = z.iso.datetime({ offset: true }).nullable();

export const PARTNER_KEY_DELIVERIES = ['copy', 'email'] as const;
export type PartnerKeyDelivery = (typeof PARTNER_KEY_DELIVERIES)[number];

export const PARTNER_KEY_OVERLAPS = ['none', '24h', '7d'] as const;
export type PartnerKeyOverlap = (typeof PARTNER_KEY_OVERLAPS)[number];

// ─── El dueño ──────────────────────────────────────────────────────────

export const CreatePartnerConnectionSchema = z.strictObject({
  partnerId: UuidSchema,
  scopes: ScopeSetSchema,
  ipAllowlist: z.array(IpEntrySchema).max(10),
  expiresAt: KeyExpirySchema,
  delivery: z.enum(PARTNER_KEY_DELIVERIES),
  totpCode: OwnerTotpSchema,
});
export type CreatePartnerConnectionDto = z.infer<typeof CreatePartnerConnectionSchema>;

export const RotatePartnerKeySchema = z.strictObject({
  overlap: z.enum(PARTNER_KEY_OVERLAPS),
  expiresAt: KeyExpirySchema,
  delivery: z.enum(PARTNER_KEY_DELIVERIES),
  totpCode: OwnerTotpSchema,
});
export type RotatePartnerKeyDto = z.infer<typeof RotatePartnerKeySchema>;

export const ResumePartnerConnectionSchema = z.strictObject({ totpCode: OwnerTotpSchema });
export type ResumePartnerConnectionDto = z.infer<typeof ResumePartnerConnectionSchema>;

/** Pausar y anular: sin cuerpo (o vacío). */
export const PartnerConnectionNoBodySchema = z.strictObject({}).optional();

export const PARTNER_CONNECTION_STATES = ['active', 'paused', 'revoked', 'expired', 'dormant'] as const;
export type PartnerConnectionState = (typeof PARTNER_CONNECTION_STATES)[number];
/** Por qué está en pausa: el dueño, el encargado, OxioPay o una pausa automática de las cargas (PR 3). */
export const PARTNER_PAUSE_REASONS = ['owner', 'manager', 'foreign_ip', 'oxiopay', 'load_refusals', 'load_burst', 'load_voids'] as const;
export type PartnerPauseReason = (typeof PARTNER_PAUSE_REASONS)[number];

/** Una plataforma que el dueño puede conectar (nada más de su empresa). */
export interface PartnerOptionView {
  id: string;
  name: string;
  /** Su techo, solo lo que hoy se puede dar. */
  allowedScopes: PartnerScope[];
  /** Las IP que declaró a OxioPay: las de la conexión van dentro. */
  egressIps: string[];
  /** Su correo de contacto, tapado: ahí llega el enlace de la clave. */
  contactEmail: string | null;
  channel: 'in_venue' | 'online';
}

export interface PartnerConnectionView {
  id: string;
  publicId: string;
  partnerId: string;
  partnerName: string;
  state: PartnerConnectionState;
  pausedBy: PartnerPauseReason | null;
  scopes: PartnerScope[];
  pausedScopes: PartnerScope[];
  mode: PartnerKeyMode;
  keyHint: string;
  keyCreatedAt: string;
  keyExpiresAt: string | null;
  /** Hasta cuándo vale la clave anterior (rotación con solape). */
  previousKeyUntil: string | null;
  keyExposedAt: string | null;
  keySuspendedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  ipAllowlist: string[];
  /** Usos rechazados desde IP ajenas, de los últimos 7 días (5 como mucho). */
  foreignIps: Array<{ ip: string; at: string }>;
  /** Los topes de carga de la conexión (céntimos). */
  limits: PartnerConnectionLimits;
  createdAt: string;
}

export interface PartnerConnectionLimits {
  perOperationCents: number;
  walletDayCents: number;
  nightCents: number;
}

// ─── Las cargas de una conexión en el panel (PR 3) ────────────────────

/**
 * Cambiar los topes de carga (OWNER): 2FA solo si sube alguno. Se llama
 * así (no PartnerLimitsSchema, que ya es el `Limits` de GET /me).
 */
export const PartnerLimitsUpdateSchema = z.strictObject({
  perOperationCents: z.number().int().min(1).max(LOAD_CAPS.perOperation.max),
  walletDayCents: z.number().int().min(1).max(LOAD_CAPS.walletDay.max),
  nightCents: z.number().int().min(1).max(LOAD_CAPS.night.max),
  totpCode: OwnerTotpSchema,
});
export type PartnerLimitsUpdateDto = z.infer<typeof PartnerLimitsUpdateSchema>;

/** Anular una carga de un socio desde el panel (OWNER y MANAGER, con 2FA). */
export const PartnerLoadVoidSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Explica por qué se anula').max(140, 'Explica por qué se anula'),
  totpCode: OwnerTotpSchema,
});
export type PartnerLoadVoidDto = z.infer<typeof PartnerLoadVoidSchema>;

/** Una carga como la ve el dueño: la del socio en camelCase, la pista del saldo y quién la anuló. */
export interface PartnerLoadAdminView {
  id: string;
  publicId: string;
  status: 'succeeded' | 'voided';
  amountCents: number;
  description: string;
  reference: string | null;
  funding: 'cash' | 'card' | 'transfer' | 'bank_app';
  device: string | null;
  createdAt: string;
  voidUntil: string;
  voidedAt: string | null;
  voidedBy: 'partner' | 'venue' | null;
  /** El motivo de la anulación (solo aquí y en sus columnas: nunca al registro ni al log). */
  reason: string | null;
  balanceAfterCents: number;
  /** «K7Q-•••»: el código del saldo, tapado. */
  codeHint: string;
}

export interface PartnerLoadsPage {
  loads: PartnerLoadAdminView[];
  nextCursor: string | null;
}

export interface PartnerConnectionsOverview {
  /** El servidor manda correos (si no, solo «La copio yo»). */
  emailEnabled: boolean;
  /** Solo al dueño y solo las listas (KYB y contrato de datos). */
  partners: PartnerOptionView[];
  connections: PartnerConnectionView[];
}

export interface PartnerKeyIssued {
  connection: PartnerConnectionView;
  /** La clave, una sola vez y solo con «La copio yo». */
  key?: string;
  claim: { sentTo: string | null; expiresAt: string | null; delivered: boolean };
}

// ─── La consola del super-admin ────────────────────────────────────────

const PartnerNameSchema = z
  .string()
  .max(200)
  .refine((s) => partnerTextProblem(s) === null, 'Sin caracteres de control, < ni >, ni enlaces o dominios.')
  .transform(cleanPartnerText)
  .pipe(z.string().min(2, 'El nombre, de 2 a 30 caracteres').max(30, 'El nombre, de 2 a 30 caracteres'));

const TaxIdSchema = z
  .string()
  .transform((s) => s.replace(/[\s.-]+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{5,20}$/, 'NIF/CIF: de 5 a 20 letras o cifras'));

const CountrySchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'País: el código de dos letras (ES, PT…)'));

const OptionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const PartnerFieldsSchema = z.object({
  name: PartnerNameSchema,
  legalName: z.string().trim().min(2).max(200),
  taxId: TaxIdSchema,
  contactEmail: z.email().max(254),
  allowedScopes: ScopeSetSchema,
  channel: z.enum(['in_venue', 'online']),
  egressIps: z.array(IpEntrySchema).max(20),
  egressRangeReason: OptionalText(500),
  kybCheckedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  kybNotes: OptionalText(2000),
  dataRole: z.enum(['PROCESSOR_OF_VENUE', 'INDEPENDENT_CONTROLLER']).nullable().optional(),
  dpaSignedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  dpaVersion: OptionalText(60),
  dataCountry: CountrySchema.nullable().optional(),
  transferMechanism: OptionalText(500),
  notes: OptionalText(2000),
});

/** Fuera del EEE hace falta el mecanismo de transferencia. */
export function partnerTransferProblem(country: string | null | undefined, mechanism: string | null | undefined): string | null {
  if (!country || (EEA_COUNTRIES as readonly string[]).includes(country)) return null;
  return mechanism?.trim() ? null : 'Fuera del EEE hace falta el mecanismo de transferencia.';
}

export const CreatePartnerSchema = PartnerFieldsSchema.extend({ totpCode: SuperAdminTotpCodeSchema.optional() }).strict();
export type CreatePartnerDto = z.infer<typeof CreatePartnerSchema>;

export const UpdatePartnerSchema = PartnerFieldsSchema.partial()
  .extend({ totpCode: SuperAdminTotpCodeSchema.optional(), reason: SuperAdminReasonSchema.optional() })
  .strict();
export type UpdatePartnerDto = z.infer<typeof UpdatePartnerSchema>;

/** Cambiar estos campos de un socio pide el 2FA (permisos, IP, KYB, contrato de datos). */
export const PARTNER_STEP_UP_FIELDS = [
  'allowedScopes',
  'egressIps',
  'egressRangeReason',
  'kybCheckedAt',
  'kybNotes',
  'dataRole',
  'dpaSignedAt',
  'dpaVersion',
  'dataCountry',
  'transferMechanism',
] as const satisfies readonly (keyof UpdatePartnerDto)[];

/** Suspender un socio o anular una conexión: 2FA y motivo. */
export const PartnerStepUpReasonSchema = z.strictObject({ totpCode: SuperAdminTotpCodeSchema, reason: SuperAdminReasonSchema });
export type PartnerStepUpReasonDto = z.infer<typeof PartnerStepUpReasonSchema>;
/** Reanudar (socio o conexión): 2FA y, si quieres, el motivo. */
export const PartnerResumeSchema = z.strictObject({ totpCode: SuperAdminTotpCodeSchema, reason: SuperAdminReasonSchema.optional() });
export type PartnerResumeDto = z.infer<typeof PartnerResumeSchema>;
/** Pausar una conexión: el motivo. */
export const PartnerPauseSchema = z.strictObject({ reason: SuperAdminReasonSchema });
export type PartnerPauseDto = z.infer<typeof PartnerPauseSchema>;

export const PARTNER_FREEZES = ['none', 'money', 'all'] as const;
export type PartnerFreeze = (typeof PARTNER_FREEZES)[number];
export const PartnerApiStateSchema = z.strictObject({
  freeze: z.enum(PARTNER_FREEZES),
  reason: SuperAdminReasonSchema,
  totpCode: SuperAdminTotpCodeSchema,
});
export type PartnerApiStateDto = z.infer<typeof PartnerApiStateSchema>;

export interface PartnerView {
  id: string;
  name: string;
  legalName: string;
  taxId: string;
  contactEmail: string;
  status: 'ACTIVE' | 'SUSPENDED';
  allowedScopes: PartnerScope[];
  collectionModel: 'VENUE_COLLECTS';
  channel: 'in_venue' | 'online';
  egressIps: string[];
  egressRangeReason: string | null;
  kybCheckedAt: string | null;
  kybNotes: string | null;
  dataRole: 'PROCESSOR_OF_VENUE' | 'INDEPENDENT_CONTROLLER' | null;
  dpaSignedAt: string | null;
  dpaVersion: string | null;
  dataCountry: string | null;
  transferMechanism: string | null;
  notes: string | null;
  /** Con KYB y contrato de datos: se le pueden dar claves. */
  ready: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SuperAdminPartnerConnectionView extends PartnerConnectionView {
  tenantId: string;
  venueName: string;
}

export interface PartnerApiStateView {
  /** PARTNER_API_ENABLED del despliegue. */
  enabled: boolean;
  mode: PartnerKeyMode | null;
  freeze: PartnerFreeze;
  reason: string | null;
  updatedAt: string;
}

export interface SuperAdminPartnersOverview {
  partners: PartnerView[];
  connections: SuperAdminPartnerConnectionView[];
  api: PartnerApiStateView;
}
