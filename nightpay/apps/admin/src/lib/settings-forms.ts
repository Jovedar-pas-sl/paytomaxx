// Ajustes del local en el panel: formularios (texto tal cual se teclea) →
// lo que se manda al API, con los mismos topes que el API. Sin React: se
// prueban solos (settings-forms.test.ts).

import {
  ALERT_KIND_KEYS,
  DEFAULT_SERVICE_FEE_BPS,
  MAX_OPERATOR_COBRO_CENTS,
  MAX_STAFF_WATCH_COUNT,
  MAX_STAFF_WATCH_FREE_CENTS,
  MAX_VENUE_PAYOUT_HOLD_DAYS,
  PERMISSION_CEILING,
  STAFF_PERMISSION_KEYS,
  commissionTotalsProblem,
  formatMoney,
  parseEuroCents,
  sectionMeta,
  serviceFeeCents,
  type AlertKindKey,
  type PermissionRole,
  type StaffPermissionKey,
  type StaffPermissions,
  type StaffWatchSettings,
  type VenueSection,
} from '@nightpay/contracts';
import type { OperatorCommissionDefaults, VenueRulesInput, VenueSettings } from './endpoints/settings';
import { bpsToPercentInput, formatPercent, parsePercentToBps } from './commission';
import { centsToInput } from './money';

// ─── Reglas del local ──────────────────────────────────────────────

export const COMMISSION_FIELDS: ReadonlyArray<{ key: keyof OperatorCommissionDefaults; label: string }> = [
  { key: 'CHICA_SERVICE', label: 'Servicio de compañera' },
  { key: 'VENUE_BAR', label: 'Bar / bebida' },
  { key: 'VENUE_ROOM', label: 'Habitación' },
  { key: 'VENUE_FOOD', label: 'Comida' },
  { key: 'VENUE_ENTRY', label: 'Entradas' },
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
      VENUE_ENTRY: bpsToPercentInput(d.VENUE_ENTRY ?? 0),
      EXTRA: bpsToPercentInput(d.EXTRA),
    },
    holdDays: s.payoutHoldDays === null || s.payoutHoldDays === undefined ? '' : String(s.payoutHoldDays),
    refundThresholdEur: centsToInput(s.refundApprovalThresholdCents ?? 100_00),
    payoutRequiresApproval: s.payoutRequiresApproval ?? true,
  };
}

/**
 * Las comisiones por sección con el nombre que les dio el local (Ajustes →
 * Secciones) o, si no lo cambió, el de fábrica; «Otros» para los cobros sin
 * sección. Las claves (y lo que se guarda) no cambian.
 */
export function commissionFields(
  sections: readonly VenueSection[],
): Array<{ key: keyof OperatorCommissionDefaults; label: string }> {
  return COMMISSION_FIELDS.map(({ key }) => ({ key, label: sectionMeta(sections, key).label }));
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
  fields: ReadonlyArray<{ key: keyof OperatorCommissionDefaults; label: string }> = COMMISSION_FIELDS,
): { ok: true; change: VenueRulesInput } | { ok: false; problem: string } {
  const max = parseEuroCents(form.maxCobroEur, MAX_OPERATOR_COBRO_CENTS);
  if (max === null) return { ok: false, problem: 'Tope por cobro: un importe entre 0,01 € y 10.000 €.' };

  const commissions = {} as OperatorCommissionDefaults;
  for (const { key, label } of fields) {
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
    COMMISSION_FIELDS.filter(({ key }) => commissions[key] !== (current.operatorCommissionDefaults[key] ?? 0)).map(({ key }) => [
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
  payouts: 'Pedir y hacer pagos a las compañeras',
  reports: 'Ver informes',
  cashTopUp: 'Cobrar recargas en efectivo',
  // Ya no se enseña (editablePermissions): el saldo no se devuelve en la salida.
  cashPayout: 'Salida en efectivo (ya no se usa)',
  chargeForOperator: 'Cobrar servicios a nombre de una compañera',
};

/** La línea de ayuda de un permiso (solo los que lo necesitan). */
export const PERMISSION_HINTS: Readonly<Partial<Record<StaffPermissionKey, string>>> = {
  chargeForOperator:
    'Escaneando su «Mi QR»: el dinero del servicio va a ella. A un camarero, dáselo solo si cobra servicios (el de recepción).',
};

/** Permisos que ya no hacen nada: no se enseñan (el saldo no se devuelve, decisión del dueño del 17-nov-2026). */
const RETIRED_PERMISSIONS: ReadonlySet<StaffPermissionKey> = new Set<StaffPermissionKey>(['cashPayout']);

export const ROLE_LABELS: Readonly<Record<PermissionRole, string>> = {
  MANAGER: 'Encargados',
  WAITER: 'Camareros',
  DEVICE: 'Datáfonos de recepción',
};

/** Lo que hacen los camareros (confirmar el datáfono, solo si el local cobra con él). */
export function waiterHint(posOn: boolean): string {
  return `${posOn ? 'Cobran y confirman datáfonos desde su app' : 'Cobran desde su app'}; de esto, solo pueden cobrar recargas en efectivo si se lo das.`;
}

/** Permisos que se pueden tocar para ese rol (camareros: las recargas en efectivo y cobrar a nombre de una compañera; datáfonos: las recargas). */
export function editablePermissions(role: PermissionRole): readonly StaffPermissionKey[] {
  return STAFF_PERMISSION_KEYS.filter((k) => PERMISSION_CEILING[role].includes(k) && !RETIRED_PERMISSIONS.has(k));
}

/**
 * Los permisos que se enseñan. «Cobrar a nombre de una compañera», solo si en
 * el local ellas no cobran desde su móvil; a los camareros, solo por persona
 * (no a todos de golpe: se le da al de recepción).
 */
export function shownPermissions(
  role: PermissionRole,
  { servicesOff, perPerson }: { servicesOff: boolean; perPerson: boolean },
): readonly StaffPermissionKey[] {
  const show = servicesOff && (perPerson || role !== 'WAITER');
  return editablePermissions(role).filter((k) => k !== 'chargeForOperator' || show);
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
  chicas: 'Descuentos a compañeras que fallaron',
  nights: 'Noches cerradas con pendientes',
  pos: 'Datáfonos que no cuadran',
  wallets: 'Saldos de clientes',
  bank: 'Diferencias con el banco',
  backups: 'Copias de seguridad',
  approvals: 'Solicitudes por aprobar',
  summary: 'Resumen de las 9:00',
};

export const ALERT_KINDS: readonly AlertKindKey[] = ALERT_KIND_KEYS;

/** Avisos por persona: el formulario (texto tal cual se teclea). */
export interface StaffWatchForm {
  cancels: string;
  freeAmountEur: string;
  pinFailSaldos: string;
  sameSaldoCharges: string;
}

export function staffWatchFormFrom(w: StaffWatchSettings): StaffWatchForm {
  return {
    cancels: String(w.cancels),
    freeAmountEur: centsToInput(w.freeAmountCents),
    pinFailSaldos: String(w.pinFailSaldos),
    sameSaldoCharges: String(w.sameSaldoCharges),
  };
}

/** Lo que cambia (con los topes del API; 0 = no avisar) o por qué no se puede guardar. */
export function staffWatchChange(
  form: StaffWatchForm,
  current: StaffWatchSettings,
): { ok: true; change: Partial<StaffWatchSettings> } | { ok: false; problem: string } {
  const count = (v: string): number | null => (/^\s*\d{1,2}\s*$/.test(v) ? Number(v) : null);
  const counts = [
    ['cancels', 'Cobros cancelados'],
    ['pinFailSaldos', 'Saldos con el PIN fallado'],
    ['sameSaldoCharges', 'Cobros seguidos al mismo saldo'],
  ] as const;
  const next: StaffWatchSettings = { ...current };
  for (const [key, label] of counts) {
    const n = count(form[key]);
    if (n === null || n > MAX_STAFF_WATCH_COUNT) return { ok: false, problem: `${label}: un número de 0 a ${MAX_STAFF_WATCH_COUNT} (0 = no avisar).` };
    next[key] = n;
  }
  const free = /^\s*0+(?:[.,]0{1,2})?\s*€?\s*$/.test(form.freeAmountEur) ? 0 : parseEuroCents(form.freeAmountEur, MAX_STAFF_WATCH_FREE_CENTS);
  if (free === null) return { ok: false, problem: `«Otro importe»: de 0 € (no avisar) a ${MAX_STAFF_WATCH_FREE_CENTS / 100} €.` };
  next.freeAmountCents = free;
  const change = Object.fromEntries(Object.entries(next).filter(([k, v]) => current[k as keyof StaffWatchSettings] !== v));
  return { ok: true, change };
}

// ─── «Comisión del servicio al cliente» (Ajustes → Reglas, solo se ve) ──

const SPLIT_HINT = 'Lo de cada categoría es para quien crea el cobro; el resto, para el local.';

/** La ayuda de «Cobros de las chicas»: lo que se lleva OxioPay (con la comisión del servicio, nada del local). */
export function platformCommissionHint(s: VenueSettings): string {
  if (s.serviceFeeEnabled) {
    return `Con la comisión del servicio encendida, lo pagado con ella no paga esta comisión (la paga el cliente encima); el saldo cargado antes de encenderla, sí, al gastarse. ${SPLIT_HINT}`;
  }
  return `OxioPay se lleva el ${formatPercent(s.platformCommissionBps)} de cada cobro (lo cambia OxioPay). ${SPLIT_HINT}`;
}

/** Lo que ve el dueño de la comisión del servicio: si está encendida y, entonces, sus % con un ejemplo. */
export function serviceFeeRulesText(s: VenueSettings): { status: 'Encendida' | 'Apagada'; lines: string[] } {
  if (!s.serviceFeeEnabled) {
    return { status: 'Apagada', lines: ['Los clientes pagan el precio, sin nada encima. La enciende OxioPay.'] };
  }
  const short = (cents: number) => formatMoney(cents, { compact: true });
  const cardBps = s.serviceFeeBps ?? DEFAULT_SERVICE_FEE_BPS;
  const topUpBps = s.topUpServiceFeeBps ?? DEFAULT_SERVICE_FEE_BPS;
  const charge = 3300;
  const topUp = 5000;
  return {
    status: 'Encendida',
    lines: [
      `Pagos con tarjeta, Apple Pay, Google Pay o datáfono: ${formatPercent(cardBps)} encima (un cobro de ${short(charge)} → el cliente paga ${short(charge + serviceFeeCents(charge, cardBps))}).`,
      `Recargas del saldo (tarjeta o efectivo): ${formatPercent(topUpBps)} encima (recarga ${short(topUp)} → paga ${short(topUp + serviceFeeCents(topUp, topUpBps))}; le quedan ${short(topUp)} de saldo).`,
      'Gastar del saldo y las propinas no la llevan. El saldo cargado antes de encenderla sigue pagando la comisión de la plataforma al gastarse. Es de OxioPay: entra con el resto del cobro y se apunta aparte.',
    ],
  };
}
