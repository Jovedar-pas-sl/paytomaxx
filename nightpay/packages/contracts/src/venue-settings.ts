import { z } from 'zod';
import { UuidSchema } from './common';

/**
 * Ajustes del local que pone el dueño (panel → Ajustes): formas de cobro,
 * permisos del personal y avisos de Telegram. Se guardan en `venues` como
 * JSON (migración 20261020100000) y lo que falte vale lo de siempre: un local
 * sin ajustes se comporta exactamente como antes.
 */

// ─── Formas de cobro ──────────────────────────────────────────────────

/** Cada forma de cobro que se puede apagar en un local. */
export const PAYMENT_METHOD_KEYS = ['card', 'wallet', 'nfc', 'pos', 'cashTopUp'] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHOD_KEYS)[number];

export interface VenuePaymentMethods {
  /** QR con tarjeta, Apple Pay o Google Pay (la página de pago del banco). */
  card: boolean;
  /** Pago con el saldo del cliente (Face ID, o su código y PIN). */
  wallet: boolean;
  /** Pago con la ficha NFC del saldo. */
  nfc: boolean;
  /** Cobro con datáfono (PAX o el del bar). */
  pos: boolean;
  /**
   * Recargas del saldo en efectivo (recepción). Encendida por defecto: el
   * permiso «cobrar recargas en efectivo» decide quién (de entrada, el encargado).
   */
  cashTopUp: boolean;
  /** El cliente puede dejar propina en la página de pago. */
  tips: boolean;
  /** Propinas sugeridas en cobros pequeños (hasta 40 €), en céntimos: +2 €, +5 €. */
  tipFlatCents: number[];
  /** Propinas sugeridas en el resto, en %: 10 %, 15 %. */
  tipPercents: number[];
}

export const DEFAULT_TIP_FLAT_CENTS: readonly number[] = [200, 500];
export const DEFAULT_TIP_PERCENTS: readonly number[] = [10, 15];
/** Sugerencias de propina por tramo (además de «Sin propina» y «Otra»). */
export const MAX_TIP_PRESETS = 3;
const MIN_TIP_FLAT_CENTS = 100;
const MAX_TIP_FLAT_CENTS = 50_00;
const MAX_TIP_PERCENT = 50;

export const DEFAULT_PAYMENT_METHODS: Readonly<VenuePaymentMethods> = Object.freeze({
  card: true,
  wallet: true,
  nfc: true,
  pos: true,
  cashTopUp: true,
  tips: true,
  tipFlatCents: [...DEFAULT_TIP_FLAT_CENTS],
  tipPercents: [...DEFAULT_TIP_PERCENTS],
});

const tipList = (min: number, max: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(1, 'Deja al menos una propina sugerida')
    .max(MAX_TIP_PRESETS, `Como mucho ${MAX_TIP_PRESETS} propinas sugeridas`);

export const UpdatePaymentMethodsSchema = z
  .object({
    card: z.boolean().optional(),
    wallet: z.boolean().optional(),
    nfc: z.boolean().optional(),
    pos: z.boolean().optional(),
    cashTopUp: z.boolean().optional(),
    tips: z.boolean().optional(),
    tipFlatCents: tipList(MIN_TIP_FLAT_CENTS, MAX_TIP_FLAT_CENTS).optional(),
    tipPercents: tipList(1, MAX_TIP_PERCENT).optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'No hay nada que cambiar' });
export type UpdatePaymentMethodsDto = z.infer<typeof UpdatePaymentMethodsSchema>;

function sortedUnique(values: unknown, min: number, max: number): number[] | null {
  if (!Array.isArray(values)) return null;
  const ok = values.filter((v): v is number => Number.isInteger(v) && v >= min && v <= max);
  const out = [...new Set(ok)].sort((a, b) => a - b).slice(0, MAX_TIP_PRESETS);
  return out.length > 0 ? out : null;
}

/** Lo guardado (JSON o null) con lo que falte a su valor de siempre. Un valor raro no rompe nada. */
export function paymentMethodsOf(raw: unknown): VenuePaymentMethods {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof VenuePaymentMethods, fallback: boolean): boolean =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : fallback;
  return {
    card: flag('card', DEFAULT_PAYMENT_METHODS.card),
    wallet: flag('wallet', DEFAULT_PAYMENT_METHODS.wallet),
    nfc: flag('nfc', DEFAULT_PAYMENT_METHODS.nfc),
    pos: flag('pos', DEFAULT_PAYMENT_METHODS.pos),
    cashTopUp: flag('cashTopUp', DEFAULT_PAYMENT_METHODS.cashTopUp),
    tips: flag('tips', DEFAULT_PAYMENT_METHODS.tips),
    tipFlatCents:
      sortedUnique(stored.tipFlatCents, MIN_TIP_FLAT_CENTS, MAX_TIP_FLAT_CENTS) ?? [...DEFAULT_TIP_FLAT_CENTS],
    tipPercents: sortedUnique(stored.tipPercents, 1, MAX_TIP_PERCENT) ?? [...DEFAULT_TIP_PERCENTS],
  };
}

/** Lo guardado tras aplicar el cambio (siempre completo y ordenado). */
export function mergePaymentMethods(current: unknown, patch: UpdatePaymentMethodsDto): VenuePaymentMethods {
  const base = paymentMethodsOf(current);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return paymentMethodsOf({ ...base, ...defined });
}

/** 409 cuando se intenta cobrar con una forma de cobro apagada en el local. */
export const PAYMENT_METHOD_DISABLED_CODE = 'PAYMENT_METHOD_DISABLED';
export const TIPS_DISABLED_CODE = 'TIPS_DISABLED';

export const PAYMENT_METHOD_DISABLED_MESSAGES: Readonly<Record<PaymentMethodKey, string>> = {
  card: 'Este local no acepta ahora cobros con tarjeta por QR (ni Apple Pay ni Google Pay). Lo cambia el dueño en Ajustes.',
  wallet: 'Este local no acepta ahora pagos ni recargas de saldo. Lo cambia el dueño en Ajustes.',
  nfc: 'Este local no acepta ahora fichas NFC. Lo cambia el dueño en Ajustes.',
  pos: 'Este local no cobra ahora con datáfono. Lo cambia el dueño en Ajustes.',
  cashTopUp: 'Este local no acepta ahora recargas en efectivo. Lo cambia el dueño en Ajustes.',
};
export const TIPS_DISABLED_MESSAGE = 'Este local no acepta propinas. Lo cambia el dueño en Ajustes.';

/**
 * Formas de cobro de un cobro con tarjeta: una recarga de saldo también
 * necesita el saldo. Con datáfono (también la recarga en la recepción del
 * PAX), el datáfono en vez del QR con tarjeta.
 */
export function methodsNeededForPayment(p: { isWalletTopUp: boolean; isPosExternal: boolean }): PaymentMethodKey[] {
  if (p.isPosExternal) return p.isWalletTopUp ? ['pos', 'wallet'] : ['pos'];
  return p.isWalletTopUp ? ['card', 'wallet'] : ['card'];
}

/** Una recarga en efectivo necesita el saldo y la recarga en efectivo encendidos. */
export const CASH_TOP_UP_METHODS: readonly PaymentMethodKey[] = ['wallet', 'cashTopUp'];

/** La primera forma de cobro apagada de las que hacen falta (null = todas encendidas). */
export function disabledMethod(
  methods: Pick<VenuePaymentMethods, PaymentMethodKey>,
  needed: readonly PaymentMethodKey[],
): PaymentMethodKey | null {
  return needed.find((m) => !methods[m]) ?? null;
}

// ─── Permisos del personal ────────────────────────────────────────────

export const STAFF_PERMISSION_KEYS = ['refund', 'cash', 'closeNight', 'payouts', 'reports', 'cashTopUp', 'cashPayout'] as const;
export type StaffPermissionKey = (typeof STAFF_PERMISSION_KEYS)[number];

/**
 * Roles a los que el dueño da o quita permisos (él lo puede todo). DEVICE: los
 * datáfonos de recepción (no hay persona: el aparato actúa como el local).
 */
export const PERMISSION_ROLES = ['MANAGER', 'WAITER', 'DEVICE'] as const;
export type PermissionRole = (typeof PERMISSION_ROLES)[number];

export type PermissionSet = Record<StaffPermissionKey, boolean>;

/**
 * Lo más que puede hacer cada rol: un permiso quita lo que el rol ya podía
 * hacer (devolver, cerrar la noche…), y los informes los puede dar el dueño
 * al encargado. Los camareros cobran desde su app: de esto, las recargas en
 * efectivo (si el dueño se lo da) y devolver el saldo en efectivo a la salida
 * (solo con un puesto que lo haga: de fábrica, Recepción). El encargado
 * devuelve en efectivo con «Dar efectivo» (cash): «cashPayout» no es suyo. El
 * datáfono de recepción, solo las recargas en efectivo.
 */
export const PERMISSION_CEILING: Readonly<Record<PermissionRole, readonly StaffPermissionKey[]>> = {
  MANAGER: STAFF_PERMISSION_KEYS.filter((k) => k !== 'cashPayout'),
  WAITER: ['cashTopUp', 'cashPayout'],
  DEVICE: ['cashTopUp'],
};

/**
 * Hoy: el encargado devuelve, da efectivo, cierra la noche, paga a las chicas y
 * cobra recargas en efectivo; los informes, solo el dueño. Camareros: devolver
 * el saldo en efectivo a la salida, si su puesto lo hace (de fábrica, solo
 * Recepción; se le quita a una persona en Permisos sin quitarle las recargas).
 * Datáfonos, nada (el dueño les puede dar las recargas en efectivo).
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<PermissionRole, Readonly<PermissionSet>>> = {
  MANAGER: { refund: true, cash: true, closeNight: true, payouts: true, reports: false, cashTopUp: true, cashPayout: false },
  WAITER: { refund: false, cash: false, closeNight: false, payouts: false, reports: false, cashTopUp: false, cashPayout: true },
  DEVICE: { refund: false, cash: false, closeNight: false, payouts: false, reports: false, cashTopUp: false, cashPayout: false },
};

export interface StaffPermissions {
  roles: Record<PermissionRole, PermissionSet>;
  /** Excepciones por persona (userId → solo lo que cambia respecto a su rol). */
  people: Record<string, Partial<PermissionSet>>;
}

const PermissionPatchSchema = z
  .object(Object.fromEntries(STAFF_PERMISSION_KEYS.map((k) => [k, z.boolean().optional()])) as Record<
    StaffPermissionKey,
    z.ZodOptional<z.ZodBoolean>
  >)
  .strict();

export const UpdateStaffPermissionsSchema = z
  .object({
    roles: z
      .object({
        MANAGER: PermissionPatchSchema.optional(),
        WAITER: PermissionPatchSchema.optional(),
        DEVICE: PermissionPatchSchema.optional(),
      })
      .strict()
      .optional(),
    /** null = quitar la excepción de esa persona (vuelve a lo de su rol). */
    people: z.record(UuidSchema, PermissionPatchSchema.nullable()).optional(),
  })
  .strict()
  .refine((d) => d.roles !== undefined || d.people !== undefined, { message: 'No hay nada que cambiar' });
export type UpdateStaffPermissionsDto = z.infer<typeof UpdateStaffPermissionsSchema>;

const MAX_PEOPLE_OVERRIDES = 200;

function permissionSetOf(raw: unknown, fallback: Readonly<PermissionSet>, role: PermissionRole): PermissionSet {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ceiling = new Set(PERMISSION_CEILING[role]);
  const out = { ...fallback };
  for (const key of STAFF_PERMISSION_KEYS) {
    const v = stored[key];
    if (typeof v === 'boolean') out[key] = v;
    if (!ceiling.has(key)) out[key] = false;
  }
  return out;
}

function partialSetOf(raw: unknown): Partial<PermissionSet> {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Partial<PermissionSet> = {};
  for (const key of STAFF_PERMISSION_KEYS) {
    const v = stored[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** Lo guardado (JSON o null) con lo de siempre donde falte; nada pasa del techo de cada rol. */
export function staffPermissionsOf(raw: unknown): StaffPermissions {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const roles = stored.roles && typeof stored.roles === 'object' ? (stored.roles as Record<string, unknown>) : {};
  const peopleRaw =
    stored.people && typeof stored.people === 'object' ? (stored.people as Record<string, unknown>) : {};
  const people: Record<string, Partial<PermissionSet>> = {};
  for (const [userId, value] of Object.entries(peopleRaw).slice(0, MAX_PEOPLE_OVERRIDES)) {
    const set = partialSetOf(value);
    if (Object.keys(set).length > 0) people[userId] = set;
  }
  return {
    roles: {
      MANAGER: permissionSetOf(roles.MANAGER, DEFAULT_ROLE_PERMISSIONS.MANAGER, 'MANAGER'),
      WAITER: permissionSetOf(roles.WAITER, DEFAULT_ROLE_PERMISSIONS.WAITER, 'WAITER'),
      DEVICE: permissionSetOf(roles.DEVICE, DEFAULT_ROLE_PERMISSIONS.DEVICE, 'DEVICE'),
    },
    people,
  };
}

/** Lo guardado tras el cambio (una excepción a null se quita: vuelve a lo de su rol). */
export function mergeStaffPermissions(current: unknown, patch: UpdateStaffPermissionsDto): StaffPermissions {
  const base = staffPermissionsOf(current);
  const roles = {
    MANAGER: { ...base.roles.MANAGER, ...definedOnly(patch.roles?.MANAGER) },
    WAITER: { ...base.roles.WAITER, ...definedOnly(patch.roles?.WAITER) },
    DEVICE: { ...base.roles.DEVICE, ...definedOnly(patch.roles?.DEVICE) },
  };
  const people = { ...base.people };
  for (const [userId, change] of Object.entries(patch.people ?? {})) {
    if (change === null) {
      delete people[userId];
      continue;
    }
    people[userId] = { ...people[userId], ...definedOnly(change) };
  }
  return staffPermissionsOf({ roles, people });
}

function definedOnly(p: Partial<PermissionSet> | undefined): Partial<PermissionSet> {
  return Object.fromEntries(Object.entries(p ?? {}).filter(([, v]) => v !== undefined)) as Partial<PermissionSet>;
}

/**
 * ¿Puede esta persona hacer esto? El dueño, siempre. Un rol fuera de la tabla
 * (la chica) no tiene estas acciones: no. Si no, su excepción o la de su rol,
 * nunca por encima del techo del rol.
 */
export function staffCan(
  perms: StaffPermissions,
  actor: { role: string; userId: string },
  key: StaffPermissionKey,
): boolean {
  if (actor.role === 'OWNER') return true;
  if (actor.role !== 'MANAGER' && actor.role !== 'WAITER') return false;
  const role: PermissionRole = actor.role;
  if (!PERMISSION_CEILING[role].includes(key)) return false;
  const own = perms.people[actor.userId]?.[key];
  return typeof own === 'boolean' ? own : perms.roles[role][key];
}

/**
 * ¿Puede el datáfono de recepción hacer esto? Sin persona (ni excepciones):
 * lo que el dueño dejó a los datáfonos, nunca por encima de su techo.
 */
export function deviceCan(perms: StaffPermissions, key: StaffPermissionKey): boolean {
  return PERMISSION_CEILING.DEVICE.includes(key) && perms.roles.DEVICE[key];
}

export const STAFF_PERMISSION_DENIED_CODE = 'STAFF_PERMISSION_DENIED';

export const STAFF_PERMISSION_DENIED_MESSAGES: Readonly<Record<StaffPermissionKey, string>> = {
  refund: 'El dueño del local no te deja hacer devoluciones.',
  cash: 'El dueño del local no te deja dar efectivo ni anular consumos.',
  closeNight: 'El dueño del local no te deja cerrar la noche.',
  payouts: 'El dueño del local no te deja pedir ni hacer pagos a las chicas.',
  reports: 'El dueño del local no te deja ver los informes.',
  cashTopUp: 'El dueño del local no te deja cobrar recargas en efectivo.',
  cashPayout: 'El dueño del local no te deja devolver saldo en efectivo.',
};

/** El datáfono de recepción sin permiso para el efectivo (Ajustes → Permisos → Datáfonos). */
export const DEVICE_CASH_TOP_UP_DENIED_MESSAGE =
  'El dueño no deja cobrar recargas en efectivo en el datáfono (Ajustes → Permisos → Datáfonos).';

// ─── Avisos de Telegram ───────────────────────────────────────────────

/** Grupos de avisos que el dueño enciende o apaga. */
export const ALERT_KIND_KEYS = [
  'payments',
  'refunds',
  'chicas',
  'nights',
  'pos',
  'wallets',
  'bank',
  'backups',
  'approvals',
  'summary',
] as const;
export type AlertKindKey = (typeof ALERT_KIND_KEYS)[number];

/** Tipo de incidencia (Incidencias) → su grupo de avisos. Uno nuevo cae en «payments». */
const INCIDENT_ALERT_KIND: Readonly<Record<string, AlertKindKey>> = {
  stuck_payment: 'payments',
  duplicate_charge: 'payments',
  amount_mismatch: 'payments',
  approval_unverified: 'payments',
  approval_unbooked: 'payments',
  refund_pending: 'refunds',
  earning_reverse_failed: 'chicas',
  night_closed_pending: 'nights',
  pos_charge_mismatch: 'pos',
  pos_unmatched_op: 'pos',
  pos_unreconciled: 'pos',
  pos_voided_paid: 'pos',
  pos_unproven_sales: 'pos',
  pos_reception_limit: 'pos',
  wallet_credit_skipped: 'wallets',
  wallet_close_requested: 'wallets',
  wallet_open_balance: 'wallets',
  wallet_topup_unassigned: 'wallets',
  reception_payout_cap: 'wallets',
  bank_mismatch: 'bank',
  backup_stale: 'backups',
  backup_unmonitored: 'backups',
  approval_pending: 'approvals',
};

export function alertKindForIncident(kind: string): AlertKindKey {
  return INCIDENT_ALERT_KIND[kind] ?? 'payments';
}

export interface VenueAlertSettings {
  kinds: Record<AlertKindKey, boolean>;
  /** Chat propio del local; null = el de TELEGRAM_CHAT_ID. */
  chatId: string | null;
  /** Nombres de las chicas en los mensajes (Telegram es un tercero): por defecto, no. */
  includeNames: boolean;
}

/** Id numérico del chat (grupos en negativo) o @canal. */
export const TELEGRAM_CHAT_ID_RE = /^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export const DEFAULT_ALERT_SETTINGS: Readonly<VenueAlertSettings> = Object.freeze({
  kinds: Object.fromEntries(ALERT_KIND_KEYS.map((k) => [k, true])) as Record<AlertKindKey, boolean>,
  chatId: null,
  includeNames: false,
});

export const UpdateAlertSettingsSchema = z
  .object({
    kinds: z
      .object(Object.fromEntries(ALERT_KIND_KEYS.map((k) => [k, z.boolean().optional()])) as Record<
        AlertKindKey,
        z.ZodOptional<z.ZodBoolean>
      >)
      .strict()
      .optional(),
    chatId: z
      .string()
      .trim()
      .regex(TELEGRAM_CHAT_ID_RE, 'El chat de Telegram es un número (p. ej. -1001234567890) o @canal')
      .nullable()
      .optional(),
    includeNames: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'No hay nada que cambiar' });
export type UpdateAlertSettingsDto = z.infer<typeof UpdateAlertSettingsSchema>;

export function alertSettingsOf(raw: unknown): VenueAlertSettings {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kindsRaw = stored.kinds && typeof stored.kinds === 'object' ? (stored.kinds as Record<string, unknown>) : {};
  const kinds = { ...DEFAULT_ALERT_SETTINGS.kinds };
  for (const key of ALERT_KIND_KEYS) {
    if (typeof kindsRaw[key] === 'boolean') kinds[key] = kindsRaw[key] as boolean;
  }
  const chat = typeof stored.chatId === 'string' ? stored.chatId.trim() : '';
  return {
    kinds,
    chatId: TELEGRAM_CHAT_ID_RE.test(chat) ? chat : null,
    includeNames: stored.includeNames === true,
  };
}

export function mergeAlertSettings(current: unknown, patch: UpdateAlertSettingsDto): VenueAlertSettings {
  const base = alertSettingsOf(current);
  return alertSettingsOf({
    kinds: { ...base.kinds, ...Object.fromEntries(Object.entries(patch.kinds ?? {}).filter(([, v]) => v !== undefined)) },
    chatId: patch.chatId === undefined ? base.chatId : patch.chatId,
    includeNames: patch.includeNames ?? base.includeNames,
  });
}
