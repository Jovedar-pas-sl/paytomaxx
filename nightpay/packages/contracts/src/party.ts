import { z } from 'zod';
import { UuidSchema } from './common';
import { isValidIban } from './operators';
import { RoleSchema } from './auth';
import { normalizeIban } from './superadmin';

// ═══════════════════════════════════════════════════════════════════════
// OxioParty: la edición de OxioPay para fiestas (peñas, Fallas, bares) con
// pulsera NFC y saldo prepago. Mismo código; se elige con la variable de
// entorno EDITION del API (NEXT_PUBLIC_EDITION en las apps, al construir).
// Con 'club' (por defecto) todo es OxioPay, como siempre. Ver docs/OXIOPARTY.md.
//
//   GET/PATCH  /v1/admin/party/settings        la fiesta (PATCH: solo el dueño)
//   GET/POST   /v1/admin/party/stalls          casetas (dueño y encargado)
//   PATCH/DELETE /v1/admin/party/stalls/:id
//   GET        /v1/admin/party/staff           el personal con su caseta
//   PATCH      /v1/admin/party/staff/:userId   cambiar la caseta de una persona
// Con EDITION=club estas rutas no existen (404). La edición: ./edition.ts.
// ═══════════════════════════════════════════════════════════════════════

// ─── La fiesta terminó ──────────────────────────────────────────────────

/** Con EDITION=party y el fin de la fiesta ya pasado: sin cobros ni recargas nuevos. */
export const EVENT_ENDED_CODE = 'EVENT_ENDED';
export const EVENT_ENDED_MESSAGE =
  'La fiesta ya ha terminado: no se pueden hacer cobros ni recargas nuevos. Las consultas, los cierres y las devoluciones siguen.';

/** ¿Ya terminó? Sin fecha de fin, nunca. */
export function isEventEnded(eventEndsAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!eventEndsAt) return false;
  const end = eventEndsAt instanceof Date ? eventEndsAt : new Date(eventEndsAt);
  return !Number.isNaN(end.getTime()) && end.getTime() <= now.getTime();
}

/**
 * Terminada la fiesta, el fin no se quita ni se retrasa (409 EVENT_LOCKED):
 * reabrirla dejaría cambiar otra vez el % de las casetas (STALL_BPS_LOCKED)
 * y el cierre. Adelantarlo sí (sigue terminada); lo demás de los ajustes, también.
 */
export const EVENT_LOCKED_CODE = 'EVENT_LOCKED';
export const EVENT_LOCKED_MESSAGE =
  'La fiesta ya ha terminado: el fin no se puede quitar ni retrasar (así el cierre y el % de cada caseta no cambian). Lo demás sí se puede cambiar.';

/** ¿Este nuevo fin reabriría la fiesta? `next` undefined: no se cambia; null: se quita. */
export function reopensEvent(
  current: Date | string | null | undefined,
  next: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (next === undefined || !isEventEnded(current, now)) return false;
  if (next === null) return true;
  const end = new Date(current as Date | string).getTime();
  const after = (next instanceof Date ? next : new Date(next)).getTime();
  return Number.isNaN(after) || after > end;
}

// ─── Casetas ────────────────────────────────────────────────────────────

/** La parte del organizador entera: «barra propia». */
export const ORGANIZER_OWN_BAR_BPS = 10_000;
/** La parte de lo vendido que se queda el organizador (bps: 2500 = 25 %). */
export const OrganizerBpsSchema = z.number().int().min(0, 'De 0 a 100 %').max(ORGANIZER_OWN_BAR_BPS, 'De 0 a 100 %');

/** IBAN de la caseta: se guarda sin espacios y en mayúsculas, con su dígito de control (mod-97). */
export const StallIbanSchema = z
  .string()
  .max(50)
  .transform(normalizeIban)
  .refine(isValidIban, 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra)');

const StallNameSchema = z.string().trim().min(1, 'Pon el nombre de la caseta').max(80);
const ManagerNameSchema = z.string().trim().min(1, 'Pon el nombre del responsable').max(120);
const ManagerContactSchema = z.string().trim().min(1).max(160);
const SortOrderSchema = z.number().int().min(0).max(10_000);
/** 2FA de quien la cambia (si la tiene activada): la parte del organizador y el IBAN son dinero. */
const StepUpCodeSchema = z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras');

/** Lo que va con la persona («me») y con los cobros: la caseta, corta. */
export const StallRefSchema = z.object({ id: UuidSchema, name: z.string() });
export type StallRef = z.infer<typeof StallRefSchema>;

export const StallSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  managerName: z.string(),
  managerContact: z.string().nullable(),
  organizerBps: z.number().int(),
  /** «Barra propia»: todo para el organizador (organizerBps = 10000). */
  ownBar: z.boolean(),
  iban: z.string().nullable(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  /** Personas con esta caseta. */
  staffCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StallView = z.infer<typeof StallSchema>;

export const CreateStallSchema = z.object({
  name: StallNameSchema,
  managerName: ManagerNameSchema,
  managerContact: ManagerContactSchema.nullable().optional(),
  organizerBps: OrganizerBpsSchema,
  iban: StallIbanSchema.nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: SortOrderSchema.optional(),
  totpCode: StepUpCodeSchema.optional(),
});
export type CreateStallDto = z.infer<typeof CreateStallSchema>;

export const UpdateStallSchema = z
  .object({
    name: StallNameSchema.optional(),
    managerName: ManagerNameSchema.optional(),
    managerContact: ManagerContactSchema.nullable().optional(),
    organizerBps: OrganizerBpsSchema.optional(),
    iban: StallIbanSchema.nullable().optional(),
    active: z.boolean().optional(),
    sortOrder: SortOrderSchema.optional(),
    totpCode: StepUpCodeSchema.optional(),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'totpCode' && x !== undefined), 'No hay nada que cambiar');
export type UpdateStallDto = z.infer<typeof UpdateStallSchema>;

/**
 * Con la fiesta terminada (eventEndsAt pasado), la parte del organizador de
 * una caseta ya no cambia: así el cierre tampoco. El resto de datos, sí. 409.
 */
export const STALL_BPS_LOCKED_CODE = 'STALL_BPS_LOCKED';
export const STALL_BPS_LOCKED_MESSAGE =
  'La fiesta ya ha terminado: el % de la organización de cada caseta ya no se puede cambiar, para que el cierre no cambie. El resto de datos, sí.';

/** ¿El cambio toca dinero (la parte del organizador o el IBAN)? Entonces, 2FA si la tiene. */
export function stallChangeTouchesMoney(dto: { organizerBps?: number; iban?: string | null }): boolean {
  return dto.organizerBps !== undefined || dto.iban !== undefined;
}

// ─── El personal y su caseta ────────────────────────────────────────────

/** Quién puede tener caseta: el personal (el dueño organiza, no trabaja en una). */
export const STALL_STAFF_ROLES = ['MANAGER', 'WAITER', 'OPERATOR'] as const;

export const StallStaffSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  role: RoleSchema,
  stallId: UuidSchema.nullable(),
});
export type StallStaffPerson = z.infer<typeof StallStaffSchema>;

/** null = sin caseta. */
export const AssignStallSchema = z.object({ stallId: UuidSchema.nullable() });
export type AssignStallDto = z.infer<typeof AssignStallSchema>;

// ─── Ajustes de la fiesta ───────────────────────────────────────────────

/** Umbral del aviso de efectivo: de 0 a 100.000 € (de serie, 2.000 €). */
export const DEFAULT_CASH_ALERT_CENTS = 200_000;
export const MAX_CASH_ALERT_CENTS = 10_000_000;

const DateTimeSchema = z.string().datetime({ offset: true });
const DayRe = /^\d{4}-\d{2}-\d{2}$/;
const DaySchema = z
  .string()
  .regex(DayRe, 'Fecha AAAA-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Esa fecha no existe');

export const PartySettingsSchema = z.object({
  eventStartsAt: z.string().nullable(),
  eventEndsAt: z.string().nullable(),
  /** Último día para pedir la devolución del saldo (AAAA-MM-DD). */
  refundDeadline: z.string().nullable(),
  /** El cliente puede donar lo que le sobra. */
  allowDonation: z.boolean(),
  /** Aviso de efectivo acumulado, en céntimos. */
  cashAlertCents: z.number().int(),
  /** La fiesta ya terminó: no hay cobros ni recargas nuevos. */
  eventEnded: z.boolean(),
});
export type PartySettings = z.infer<typeof PartySettingsSchema>;

export const UpdatePartySettingsSchema = z
  .object({
    eventStartsAt: DateTimeSchema.nullable().optional(),
    eventEndsAt: DateTimeSchema.nullable().optional(),
    refundDeadline: DaySchema.nullable().optional(),
    allowDonation: z.boolean().optional(),
    cashAlertCents: z.number().int().min(0).max(MAX_CASH_ALERT_CENTS).optional(),
    totpCode: StepUpCodeSchema.optional(),
  })
  .refine((v) => Object.entries(v).some(([k, x]) => k !== 'totpCode' && x !== undefined), 'No hay nada que cambiar');
export type UpdatePartySettingsDto = z.infer<typeof UpdatePartySettingsSchema>;

/** Lo que queda tras el cambio no vale (null = vale): el fin, después del inicio. */
export function partySettingsProblem(s: { eventStartsAt: Date | string | null; eventEndsAt: Date | string | null }): string | null {
  if (!s.eventStartsAt || !s.eventEndsAt) return null;
  return new Date(s.eventEndsAt).getTime() > new Date(s.eventStartsAt).getTime()
    ? null
    : 'El fin de la fiesta tiene que ser después del inicio';
}
