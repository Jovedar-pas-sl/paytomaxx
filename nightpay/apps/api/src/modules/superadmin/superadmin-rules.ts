import { randomBytes } from 'node:crypto';
import {
  VENUE_PROFILE_STEP_UP_FIELDS,
  commissionTotalsProblem,
  type CreateVenueDto,
  type OperatorCommissionDefaults,
  type UpdateBusinessDto,
  type UpdateVenueProfileDto,
  type UpdateVenueRulesDto,
} from '@nightpay/contracts';
import { DEFAULT_COMMISSION_DEFAULTS } from '../payments/commission';

/** Reglas puras de la consola del super-admin (sin base ni Nest: se prueban solas). */

// ─── Reglas del local ─────────────────────────────────────────────────

export interface CurrentVenueRules {
  operatorMaxCobroCents: number;
  platformCommissionBps: number;
  operatorCommissionDefaults: unknown;
  payoutHoldDays: number | null;
  refundApprovalThresholdCents: number;
  payoutRequiresApproval: boolean;
}

export interface VenueRulesChange {
  operatorMaxCobroCents?: number;
  platformCommissionBps?: number;
  operatorCommissionDefaults?: OperatorCommissionDefaults;
  payoutHoldDays?: number | null;
  refundApprovalThresholdCents?: number;
  payoutRequiresApproval?: boolean;
}

/** El mapa de comisiones guardado (JSON) con las categorías que falten a su valor por defecto. */
export function commissionMapOf(raw: unknown): OperatorCommissionDefaults {
  const stored = raw && typeof raw === 'object' ? (raw as Partial<OperatorCommissionDefaults>) : {};
  const out = { ...DEFAULT_COMMISSION_DEFAULTS };
  for (const key of Object.keys(out) as Array<keyof OperatorCommissionDefaults>) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isInteger(v)) out[key] = v;
  }
  return out;
}

/**
 * Lo que se guarda al cambiar las reglas: las comisiones parciales se mezclan
 * con las guardadas y el resultado (lo nuevo + lo que queda) tiene que
 * cuadrar: chica + plataforma ≤ 100 % en cada categoría y con el % propio más
 * alto de las chicas del local. Devuelve el cambio o el motivo del 400.
 */
export function planVenueRulesChange(
  current: CurrentVenueRules,
  dto: Omit<UpdateVenueRulesDto, 'totpCode'>,
  maxOperatorOverrideBps: number | null,
): { ok: true; change: VenueRulesChange } | { ok: false; problem: string } {
  const change: VenueRulesChange = {};
  if (dto.operatorMaxCobroCents !== undefined) change.operatorMaxCobroCents = dto.operatorMaxCobroCents;
  if (dto.platformCommissionBps !== undefined) change.platformCommissionBps = dto.platformCommissionBps;
  if (dto.operatorCommissionDefaults !== undefined) {
    const patch = Object.fromEntries(
      Object.entries(dto.operatorCommissionDefaults).filter(([, v]) => v !== undefined),
    ) as Partial<OperatorCommissionDefaults>;
    change.operatorCommissionDefaults = { ...commissionMapOf(current.operatorCommissionDefaults), ...patch };
  }
  if (dto.payoutHoldDays !== undefined) change.payoutHoldDays = dto.payoutHoldDays;
  if (dto.refundApprovalThresholdCents !== undefined) change.refundApprovalThresholdCents = dto.refundApprovalThresholdCents;
  if (dto.payoutRequiresApproval !== undefined) change.payoutRequiresApproval = dto.payoutRequiresApproval;

  const problem = commissionTotalsProblem({
    platformCommissionBps: change.platformCommissionBps ?? current.platformCommissionBps,
    operatorCommissionDefaults: change.operatorCommissionDefaults ?? commissionMapOf(current.operatorCommissionDefaults),
    maxOperatorOverrideBps,
  });
  return problem ? { ok: false, problem } : { ok: true, change };
}

/** Dar de alta un local con grupo del saldo o comisión propia pide 2FA (como cambiarlos después). */
export function venueCreateNeedsStepUp(dto: CreateVenueDto): boolean {
  return Boolean(dto.walletGroup) || dto.platformCommissionBps !== undefined;
}

/** Cambiar la comisión por defecto del negocio (a otro valor) pide 2FA; reenviarla igual, no. */
export function businessUpdateNeedsStepUp(
  dto: UpdateBusinessDto,
  current: { defaultPlatformCommissionBps: number | null },
): boolean {
  return dto.defaultPlatformCommissionBps !== undefined && dto.defaultPlatformCommissionBps !== current.defaultPlatformCommissionBps;
}

/** Cambiar el grupo del saldo o el IVA del local pide 2FA; el nombre o la zona, no. */
export function profileNeedsStepUp(dto: UpdateVenueProfileDto): boolean {
  return VENUE_PROFILE_STEP_UP_FIELDS.some((field) => dto[field] !== undefined);
}

// ─── Super-admins ─────────────────────────────────────────────────────

/**
 * Quitar el permiso de super-admin (o dar de baja a uno): nunca dejar la
 * plataforma sin ninguno activo. `activeSuperAdminIds` = los activos ahora.
 * null si se puede; si no, el motivo (409).
 */
export function superAdminRemovalProblem(input: {
  activeSuperAdminIds: ReadonlyArray<string>;
  targetId: string;
  actorId: string;
}): string | null {
  if (!input.activeSuperAdminIds.includes(input.targetId)) return null;
  const remaining = input.activeSuperAdminIds.filter((id) => id !== input.targetId);
  if (remaining.length > 0) return null;
  return input.targetId === input.actorId
    ? 'Eres el último super-admin: nombra antes a otro (no te puedes quitar el permiso)'
    : 'Es el último super-admin: nombra antes a otro';
}

// ─── Contraseñas temporales ───────────────────────────────────────────

/** Sin letras que se confunden (0/O, l/I), como el reset de la chica. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 12;

/** Contraseña temporal legible de 12 caracteres (se enseña una vez; se guarda solo el hash). */
export function generateTemporaryPassword(): string {
  // Rechazo de los bytes del final: cada carácter igual de probable.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  const out: string[] = [];
  while (out.length < TEMP_PASSWORD_LENGTH) {
    for (const b of randomBytes(TEMP_PASSWORD_LENGTH * 2)) {
      if (b < limit && out.length < TEMP_PASSWORD_LENGTH) out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]!);
    }
  }
  return out.join('');
}
