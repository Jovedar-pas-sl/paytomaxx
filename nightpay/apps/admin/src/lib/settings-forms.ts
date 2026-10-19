// Ajustes del local en el panel: formularios (texto tal cual se teclea) →
// lo que se manda al API, con los mismos topes que el API. Sin React: se
// prueban solos (settings-forms.test.ts).

import {
  ALERT_KIND_KEYS,
  MAX_OPERATOR_COBRO_CENTS,
  MAX_VENUE_PAYOUT_HOLD_DAYS,
  PERMISSION_CEILING,
  STAFF_PERMISSION_KEYS,
  commissionTotalsProblem,
  parseEuroCents,
  type AlertKindKey,
  type PermissionRole,
  type StaffPermissionKey,
  type StaffPermissions,
} from '@nightpay/contracts';
import type { OperatorCommissionDefaults, VenueRulesInput, VenueSettings } from './endpoints/settings';
import { bpsToPercentInput, parsePercentToBps } from './commission';
import { centsToInput } from './money';

// ─── Reglas del local ──────────────────────────────────────────────

export const COMMISSION_FIELDS: ReadonlyArray<{ key: keyof OperatorCommissionDefaults; label: string }> = [
  { key: 'CHICA_SERVICE', label: 'Servicio de chica' },
  { key: 'VENUE_BAR', label: 'Bar / bebida' },
  { key: 'VENUE_ROOM', label: 'Habitación' },
  { key: 'VENUE_FOOD', label: 'Comida' },
  { key: 'EXTRA', label: 'Otros' },
];

export interface RulesForm {
  maxCobroEur: string;
  commissions: Record<keyof OperatorCommissionDefaults, string>;
  /** '' = lo del servidor. */
  holdDays: string;
  refundThresholdEur: string;
  payoutRequiresApproval: boolean;
}

export function rulesFormFrom(s: VenueSettings): RulesForm {
  const d = s.operatorCommissionDefaults;
  return {
    maxCobroEur: centsToInput(s.operatorMaxCobroCents),
    commissions: {
      CHICA_SERVICE: bpsToPercentInput(d.CHICA_SERVICE),
      VENUE_BAR: bpsToPercentInput(d.VENUE_BAR),
      VENUE_ROOM: bpsToPercentInput(d.VENUE_ROOM),
      VENUE_FOOD: bpsToPercentInput(d.VENUE_FOOD),
      EXTRA: bpsToPercentInput(d.EXTRA),
    },
    holdDays: s.payoutHoldDays === null || s.payoutHoldDays === undefined ? '' : String(s.payoutHoldDays),
    refundThresholdEur: centsToInput(s.refundApprovalThresholdCents ?? 100_00),
    payoutRequiresApproval: s.payoutRequiresApproval ?? true,
  };
}

/** Euros que pueden ser 0 ("0", "0,00"): el umbral de devolución. */
function parseEurosAllowZero(input: string): number | null {
  if (/^\s*0+(?:[.,]0{1,2})?\s*€?\s*$/.test(input)) return 0;
  return parseEuroCents(input, MAX_OPERATOR_COBRO_CENTS);
}

/**
 * Lo que cambia (solo lo distinto de lo guardado) o el motivo para no
 * mandarlo: importes, porcentajes, días de 0 a 60 y chica + OxioPay ≤ 100 %
 * (la misma regla que el API y la consola del super-admin).
 */
export function rulesChange(
  form: RulesForm,
  current: VenueSettings,
): { ok: true; change: VenueRulesInput } | { ok: false; problem: string } {
  const max = parseEuroCents(form.maxCobroEur, MAX_OPERATOR_COBRO_CENTS);
  if (max === null) return { ok: false, problem: 'Tope por cobro: un importe entre 0,01 € y 10.000 €.' };

  const commissions = {} as OperatorCommissionDefaults;
  for (const { key, label } of COMMISSION_FIELDS) {
    const bps = parsePercentToBps(form.commissions[key]);
    if (bps === null) return { ok: false, problem: `${label}: un porcentaje de 0 a 100 (por ejemplo 10 o 10,5).` };
    commissions[key] = bps;
  }
  const total = commissionTotalsProblem({
    platformCommissionBps: current.platformCommissionBps,
    operatorCommissionDefaults: commissions,
  });
  if (total) return { ok: false, problem: total };

  const daysText = form.holdDays.trim();
  const holdDays = daysText === '' ? null : /^\d{1,2}$/.test(daysText) ? Number(daysText) : NaN;
  if (holdDays !== null && !(Number.isInteger(holdDays) && holdDays <= MAX_VENUE_PAYOUT_HOLD_DAYS)) {
    return { ok: false, problem: `Días de espera: de 0 (al cerrar la noche) a ${MAX_VENUE_PAYOUT_HOLD_DAYS}, o vacío.` };
  }
  const threshold = parseEurosAllowZero(form.refundThresholdEur);
  if (threshold === null) return { ok: false, problem: 'Devoluciones con aprobación: un importe de 0 € a 10.000 €.' };

  const change: VenueRulesInput = {};
  if (max !== current.operatorMaxCobroCents) change.operatorMaxCobroCents = max;
  const changedCommissions = Object.fromEntries(
    COMMISSION_FIELDS.filter(({ key }) => commissions[key] !== current.operatorCommissionDefaults[key]).map(({ key }) => [
      key,
      commissions[key],
    ]),
  );
  if (Object.keys(changedCommissions).length > 0) change.operatorCommissionDefaults = changedCommissions;
  if (holdDays !== (current.payoutHoldDays ?? null)) change.payoutHoldDays = holdDays;
  if (threshold !== current.refundApprovalThresholdCents) change.refundApprovalThresholdCents = threshold;
  if (form.payoutRequiresApproval !== current.payoutRequiresApproval) {
    change.payoutRequiresApproval = form.payoutRequiresApproval;
  }
  return { ok: true, change };
}

/** Cómo se lee la espera: «Se paga al cerrar la noche» / «A los 7 días». */
export function holdDaysText(days: number): string {
  if (days <= 0) return 'Se les paga al cerrar la noche';
  return days === 1 ? 'Se les paga al día siguiente' : `Se les paga a los ${days} días`;
}

// ─── Propinas sugeridas ────────────────────────────────────────────

/** "2, 5" → [200, 500] (euros enteros de 1 a 50); null si algo no vale. */
export function parseTipEuros(input: string): number[] | null {
  const parts = input.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,2}$/.test(p)) return null;
    const n = Number(p);
    if (n < 1 || n > 50) return null;
    out.push(n * 100);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** "10, 15" → [10, 15] (de 1 a 50 %); null si algo no vale. */
export function parseTipPercents(input: string): number[] | null {
  const parts = input.split(/[,;\s%]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,2}$/.test(p)) return null;
    const n = Number(p);
    if (n < 1 || n > 50) return null;
    out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export const tipEurosText = (cents: readonly number[]): string => cents.map((c) => String(c / 100)).join(', ');
export const tipPercentsText = (p: readonly number[]): string => p.join(', ');

// ─── Permisos del personal ─────────────────────────────────────────

export const PERMISSION_LABELS: Readonly<Record<StaffPermissionKey, string>> = {
  refund: 'Devolver',
  cash: 'Dar efectivo y anular consumos',
  closeNight: 'Cerrar la noche',
  payouts: 'Pedir y hacer pagos a las chicas',
  reports: 'Ver informes',
  cashTopUp: 'Cobrar recargas en efectivo',
};

export const ROLE_LABELS: Readonly<Record<PermissionRole, string>> = {
  MANAGER: 'Encargados',
  WAITER: 'Camareros',
  DEVICE: 'Datáfonos de recepción',
};

/** Permisos que se pueden tocar para ese rol (camareros y datáfonos: solo las recargas en efectivo). */
export function editablePermissions(role: PermissionRole): readonly StaffPermissionKey[] {
  return STAFF_PERMISSION_KEYS.filter((k) => PERMISSION_CEILING[role].includes(k));
}

/** Lo que vale para una persona: su excepción o lo de su rol. */
export function personCan(
  perms: StaffPermissions,
  person: { id: string; role: PermissionRole },
  key: StaffPermissionKey,
): boolean {
  if (!PERMISSION_CEILING[person.role].includes(key)) return false;
  const own = perms.people[person.id]?.[key];
  return typeof own === 'boolean' ? own : perms.roles[person.role][key];
}

/** ¿Tiene esta persona alguna excepción a lo de su rol? */
export function hasOverride(perms: StaffPermissions, person: { id: string; role: PermissionRole }): boolean {
  const own = perms.people[person.id];
  if (!own) return false;
  return editablePermissions(person.role).some((k) => typeof own[k] === 'boolean' && own[k] !== perms.roles[person.role][k]);
}

// ─── Avisos de Telegram ────────────────────────────────────────────

export const ALERT_KIND_LABELS: Readonly<Record<AlertKindKey, string>> = {
  payments: 'Cobros con problemas',
  refunds: 'Devoluciones sin confirmar',
  chicas: 'Descuentos a chicas que fallaron',
  nights: 'Noches cerradas con pendientes',
  pos: 'Datáfonos que no cuadran',
  wallets: 'Saldos de clientes',
  bank: 'Diferencias con el banco',
  backups: 'Copias de seguridad',
  approvals: 'Solicitudes por aprobar',
  summary: 'Resumen de las 9:00',
};

export const ALERT_KINDS: readonly AlertKindKey[] = ALERT_KIND_KEYS;
