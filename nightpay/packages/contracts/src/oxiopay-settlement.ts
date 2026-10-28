import { z } from 'zod';
import { UuidSchema } from './common';
import { formatMoney } from './money';
import { isValidIban } from './operators';
import { SuperAdminReasonSchema, SuperAdminTotpCodeSchema, normalizeIban } from './superadmin';

// ═══════════════════════════════════════════════════════════════════════
// «Liquidación OxioPay» (2026-10-27): lo que cada local debe a OxioPay cada
// semana, de lunes 08:00 a lunes 08:00 (hora de Madrid, el corte de las
// noches). Es lo mismo que el mapa del dinero pone como de OxioPay en esa
// ventana: la comisión del servicio cobrada a los clientes (pagos directos y
// recargas) menos la devuelta, y la comisión de plataforma de siempre donde
// no hay comisión del servicio (interruptor apagado, saldo cargado antes de
// encenderla). Se paga por transferencia a la cuenta de OxioPay con la
// referencia de la liquidación. Es un resumen, no una factura.
//
//   Consola del super-admin:  /v1/superadmin/oxiopay-settlements…
//   Panel del dueño (solo lectura): /v1/admin/oxiopay-settlements…
// Ver nightpay/docs/SUPERADMIN.md («Liquidaciones OxioPay»).
// ═══════════════════════════════════════════════════════════════════════

/** El nombre, igual en todas partes. */
export const OXIOPAY_SETTLEMENT_LABEL = 'Liquidación OxioPay';
export const OXIOPAY_SETTLEMENTS_LABEL = 'Liquidaciones OxioPay';

/** Pasados estos días sin pagar entera: aviso por Telegram (una vez al día) y en el panel del dueño. */
export const SETTLEMENT_OVERDUE_DAYS = 7;

export const SETTLEMENT_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'] as const;
export const SettlementStatusSchema = z.enum(SETTLEMENT_STATUSES);
export type SettlementStatus = z.infer<typeof SettlementStatusSchema>;

export const SETTLEMENT_STATUS_LABELS: Readonly<Record<SettlementStatus, string>> = {
  ISSUED: 'Emitida',
  PARTIALLY_PAID: 'Pagada en parte',
  PAID: 'Pagada',
  VOID: 'Anulada',
};

/** Las que aún hay que cobrar (o pagar, para el local). */
export function isOpenSettlement(status: SettlementStatus): boolean {
  return status === 'ISSUED' || status === 'PARTIALLY_PAID';
}

/**
 * Conceptos del desglose. Su suma es lo que el mapa del dinero pone como de
 * OxioPay: comisión del servicio (owedCents) + comisión de plataforma (platformCents).
 */
export const SETTLEMENT_CONCEPTS = [
  'serviceFeeSales',
  'serviceFeeCardTopUps',
  'serviceFeeCashTopUps',
  'serviceFeeRefunded',
  'platformSales',
  'platformSaldo',
] as const;
export const SettlementConceptSchema = z.enum(SETTLEMENT_CONCEPTS);
export type SettlementConcept = z.infer<typeof SettlementConceptSchema>;

export const SETTLEMENT_CONCEPT_LABELS: Readonly<Record<SettlementConcept, string>> = {
  serviceFeeSales: 'Comisión del servicio · pagos con tarjeta y datáfono',
  serviceFeeCardTopUps: 'Comisión del servicio · recargas con tarjeta',
  serviceFeeCashTopUps: 'Comisión del servicio · recargas en efectivo',
  serviceFeeRefunded: 'Comisión del servicio devuelta',
  platformSales: 'Comisión de plataforma · cobros',
  platformSaldo: 'Comisión de plataforma · consumos del saldo',
};

/** En llano, debajo del concepto (documento y panel). */
export const SETTLEMENT_CONCEPT_HELP: Readonly<Record<SettlementConcept, string>> = {
  serviceFeeSales: 'La que pagó el cliente encima del precio.',
  serviceFeeCardTopUps: 'La que pagó el cliente encima de lo que recargó.',
  serviceFeeCashTopUps: 'Cobrada en efectivo: está en la caja del local.',
  serviceFeeRefunded: 'Vuelve al cliente con su devolución: deja de ser de OxioPay.',
  platformSales: 'El % de siempre, en los cobros sin comisión del servicio.',
  platformSaldo: 'El % de siempre, sobre lo gastado del saldo cargado sin comisión del servicio.',
};

export const SettlementConceptAmountsSchema = z.object({
  serviceFeeSales: z.number().int(),
  serviceFeeCardTopUps: z.number().int(),
  serviceFeeCashTopUps: z.number().int(),
  /** En negativo (resta). */
  serviceFeeRefunded: z.number().int(),
  platformSales: z.number().int(),
  platformSaldo: z.number().int(),
});
export type SettlementConceptAmounts = z.infer<typeof SettlementConceptAmountsSchema>;

export function emptyConceptAmounts(): SettlementConceptAmounts {
  return { serviceFeeSales: 0, serviceFeeCardTopUps: 0, serviceFeeCashTopUps: 0, serviceFeeRefunded: 0, platformSales: 0, platformSaldo: 0 };
}

/** Suma de los conceptos (céntimos). */
export function conceptsTotal(a: SettlementConceptAmounts): number {
  return SETTLEMENT_CONCEPTS.reduce((sum, c) => sum + a[c], 0);
}

/** Suma concepto a concepto (sin tocar las de entrada). */
export function addConcepts(a: SettlementConceptAmounts, b: SettlementConceptAmounts): SettlementConceptAmounts {
  return Object.fromEntries(SETTLEMENT_CONCEPTS.map((c) => [c, a[c] + b[c]])) as SettlementConceptAmounts;
}

/** ¿«AAAA-MM-DD» es un día que existe? (2026-02-31 no). */
export function isRealDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** ¿Es lunes? (el día en que empieza la semana de la liquidación). */
export function isMondayDay(day: string): boolean {
  if (!isRealDay(day)) return false;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
}

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD')
  .refine(isRealDay, 'Esa fecha no existe');
const MondayDay = Day.refine(isMondayDay, 'La semana de la liquidación empieza en lunes: elige un lunes');
const IsoInstant = z.string().datetime();

/** Una noche (08:00 → 08:00 de Madrid) de la semana: el día es el de las 08:00 en que empieza. */
export const SettlementNightSchema = z.object({
  day: Day,
  from: IsoInstant,
  to: IsoInstant,
  concepts: SettlementConceptAmountsSchema,
  totalCents: z.number().int(),
});
export type SettlementNight = z.infer<typeof SettlementNightSchema>;

/** Algo apuntado tarde con fecha de una semana ya liquidada: va en la siguiente. */
export const SettlementAdjustmentSchema = z.object({
  /** Lunes de la semana a la que corresponde (AAAA-MM-DD). */
  weekFrom: Day,
  isoYear: z.number().int(),
  isoWeek: z.number().int(),
  /** La liquidación de esa semana (null: no la tuvo, p. ej. salió a 0). */
  reference: z.string().nullable(),
  /** La noche (AAAA-MM-DD de las 08:00 en que empieza). */
  day: Day,
  concept: SettlementConceptSchema,
  amountCents: z.number().int(),
});
export type SettlementAdjustment = z.infer<typeof SettlementAdjustmentSchema>;

/** El local y su negocio como estaban al emitirla (congelado). */
export const SettlementPartySchema = z.object({
  venueName: z.string(),
  venueSlug: z.string(),
  businessName: z.string().nullable(),
  businessTaxId: z.string().nullable(),
});
export type SettlementParty = z.infer<typeof SettlementPartySchema>;

/** Cuenta de OxioPay para la transferencia (la pone el super-admin con 2FA). */
export const OxioPayPayeeSchema = z.object({
  name: z.string(),
  iban: z.string(),
  holder: z.string(),
  updatedAt: IsoInstant,
});
export type OxioPayPayee = z.infer<typeof OxioPayPayeeSchema>;

export const SettlementPaymentViewSchema = z.object({
  id: UuidSchema,
  amountCents: z.number().int(),
  paidOn: Day,
  bankReference: z.string(),
  reason: z.string().nullable(),
  recordedAt: IsoInstant,
  recordedByEmail: z.string().nullable(),
});
export type SettlementPaymentView = z.infer<typeof SettlementPaymentViewSchema>;

export const SettlementListItemSchema = z.object({
  id: UuidSchema,
  reference: z.string(),
  venue: z.object({ id: UuidSchema, name: z.string(), slug: z.string() }),
  business: z.object({ id: UuidSchema, name: z.string() }).nullable(),
  periodFrom: IsoInstant,
  periodTo: IsoInstant,
  isoYear: z.number().int(),
  isoWeek: z.number().int(),
  status: SettlementStatusSchema,
  periodCents: z.number().int(),
  adjustmentsCents: z.number().int(),
  totalCents: z.number().int(),
  paidCents: z.number().int(),
  pendingCents: z.number().int(),
  generatedAt: IsoInstant,
  /** La generó el repaso del lunes (false: el super-admin a mano). */
  auto: z.boolean(),
  /** Abierta y emitida hace más de SETTLEMENT_OVERDUE_DAYS días. */
  overdue: z.boolean(),
  /** Días desde que se emitió. */
  daysOpen: z.number().int(),
});
export type SettlementListItem = z.infer<typeof SettlementListItemSchema>;

export const SettlementDetailSchema = SettlementListItemSchema.extend({
  party: SettlementPartySchema,
  /** Las 7 noches de la semana, en orden. */
  nights: z.array(SettlementNightSchema),
  adjustments: z.array(SettlementAdjustmentSchema),
  /** Lo de la semana (sus 7 noches) por concepto: suma «Total de la semana» (los ajustes van aparte). */
  byConcept: SettlementConceptAmountsSchema,
  /** Lo que el mapa del dinero daba para esta ventana al emitirla (comprobación). */
  moneyMapCents: z.number().int(),
  payments: z.array(SettlementPaymentViewSchema),
  voidedAt: IsoInstant.nullable(),
  voidReason: z.string().nullable(),
  /** La liquidación anulada a la que sustituye (regenerada). */
  replacesId: UuidSchema.nullable(),
  /** Cuenta de OxioPay para la transferencia (null: aún no puesta, se avisa). */
  payee: OxioPayPayeeSchema.nullable(),
});
export type SettlementDetail = z.infer<typeof SettlementDetailSchema>;

/** Cifras de la consola: lo pendiente de cobrar de todos los locales. */
export const SettlementTotalsSchema = z.object({
  pendingCents: z.number().int(),
  pendingCount: z.number().int(),
  overdueCents: z.number().int(),
  overdueCount: z.number().int(),
});
export type SettlementTotals = z.infer<typeof SettlementTotalsSchema>;

export const SuperAdminSettlementPageSchema = z.object({
  items: z.array(SettlementListItemSchema),
  totals: SettlementTotalsSchema,
  /** Sin datos de cobro de OxioPay: las liquidaciones salen sin IBAN (se avisa). */
  payeeMissing: z.boolean(),
  /** Semana de inicio (lunes AAAA-MM-DD): no se liquida ni se ajusta nada anterior. */
  startWeek: z.string().nullable(),
});
export type SuperAdminSettlementPage = z.infer<typeof SuperAdminSettlementPageSchema>;

/**
 * Cambiar la semana de inicio de las liquidaciones (2FA y motivo). Nada
 * anterior se liquida ni entra como ajuste; la generación a mano la respeta.
 */
export const SetSettlementStartSchema = z.object({
  startWeek: MondayDay,
  reason: SuperAdminReasonSchema,
  totpCode: SuperAdminTotpCodeSchema,
});
export type SetSettlementStartDto = z.infer<typeof SetSettlementStartSchema>;

/** Lo que ve el dueño: las suyas, la cuenta de OxioPay y lo pendiente. */
export const OwnerSettlementPageSchema = z.object({
  items: z.array(SettlementListItemSchema),
  payee: OxioPayPayeeSchema.nullable(),
  pendingCents: z.number().int(),
});
export type OwnerSettlementPage = z.infer<typeof OwnerSettlementPageSchema>;

/** Aviso del panel del dueño: las que llevan más de 7 días sin pagar. */
export const OwnerSettlementNoticeSchema = z.object({
  overdue: z.array(z.object({ id: UuidSchema, reference: z.string(), pendingCents: z.number().int(), daysOpen: z.number().int() })),
  overdueCents: z.number().int(),
});
export type OwnerSettlementNotice = z.infer<typeof OwnerSettlementNoticeSchema>;

// ─── Filtros y escrituras ───────────────────────────────────────────────

/** `OPEN` = emitidas y pagadas en parte (lo pendiente). */
export const SettlementStatusFilterSchema = z.union([SettlementStatusSchema, z.literal('OPEN')]);
export type SettlementStatusFilter = z.infer<typeof SettlementStatusFilterSchema>;

export const SettlementListQuerySchema = z.object({
  venueId: UuidSchema.optional(),
  businessId: UuidSchema.optional(),
  status: SettlementStatusFilterSchema.optional(),
  /** Semanas que empiezan desde/hasta estos días (de Madrid, incluidos). */
  from: Day.optional(),
  to: Day.optional(),
  /** Busca en la referencia (OXP-2026-S44-…). */
  q: z.string().trim().max(80).optional(),
});
export type SettlementListQuery = z.infer<typeof SettlementListQuerySchema>;

const BankReferenceSchema = z.string().trim().min(1, 'Pon la referencia del banco').max(140);

/** Apuntar un pago (transferencia recibida). Motivo obligatorio si el importe no es lo pendiente. */
export const RecordSettlementPaymentSchema = z.object({
  amountCents: z.number().int().positive('El importe tiene que ser mayor que 0').max(100_000_000),
  /** Día del abono en el banco. */
  paidOn: Day,
  bankReference: BankReferenceSchema,
  reason: SuperAdminReasonSchema.optional(),
  /**
   * Ya hay un pago con esa referencia del banco en esta liquidación (409
   * SETTLEMENT_PAYMENT_DUPLICATE) y quien apunta confirma que es otro abono.
   */
  confirmDuplicate: z.boolean().optional(),
  totpCode: SuperAdminTotpCodeSchema,
});
export type RecordSettlementPaymentDto = z.infer<typeof RecordSettlementPaymentSchema>;

/** La referencia del banco como se compara (sin espacios de más ni mayúsculas). */
export function normalizeBankReference(ref: string): string {
  return ref.trim().replace(/\s+/g, ' ').toUpperCase();
}

export const VoidSettlementSchema = z.object({ reason: SuperAdminReasonSchema, totpCode: SuperAdminTotpCodeSchema });
export type VoidSettlementDto = z.infer<typeof VoidSettlementSchema>;

/** Generar (o regenerar tras anularla) la de un local y una semana ya terminada. */
export const GenerateSettlementSchema = z.object({
  venueId: UuidSchema,
  /** El lunes en que empieza la semana (AAAA-MM-DD). */
  week: MondayDay,
  reason: SuperAdminReasonSchema.optional(),
  totpCode: SuperAdminTotpCodeSchema,
});
export type GenerateSettlementDto = z.infer<typeof GenerateSettlementSchema>;

export const SetOxioPayPayeeSchema = z.object({
  name: z.string().trim().min(2, 'Pon el nombre').max(160),
  iban: z
    .string()
    .max(50)
    .transform(normalizeIban)
    .refine(isValidIban, 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra)'),
  holder: z.string().trim().min(2, 'Pon el titular').max(160),
  totpCode: SuperAdminTotpCodeSchema,
});
export type SetOxioPayPayeeDto = z.infer<typeof SetOxioPayPayeeSchema>;

// ─── Reglas puras (las usan el API y el panel) ──────────────────────────

/** Lo que falta por pagar. */
export function settlementPendingCents(s: { status: SettlementStatus; totalCents: number; paidCents: number }): number {
  return s.status === 'VOID' ? 0 : Math.max(0, s.totalCents - s.paidCents);
}

/**
 * Por qué no vale un pago apuntado; null si vale. Más de lo pendiente, no
 * (se reparte entre las liquidaciones); distinto de lo pendiente, con motivo.
 */
export function settlementPaymentProblem(input: { pendingCents: number; amountCents: number; reason?: string | null }): string | null {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return 'El importe tiene que ser mayor que 0.';
  if (input.pendingCents <= 0) return 'Esta liquidación no tiene nada pendiente.';
  if (input.amountCents > input.pendingCents) {
    return `El importe es mayor que lo pendiente (${formatMoney(input.pendingCents)}). Si la transferencia cubre varias, apúntala en cada una.`;
  }
  const reason = input.reason?.trim() ?? '';
  if (input.amountCents !== input.pendingCents && reason.length < 3) {
    return `El importe no coincide con lo pendiente (${formatMoney(input.pendingCents)}): pon el motivo (queda pendiente lo que falta).`;
  }
  return null;
}

/** Estado tras pagar `paidCents` de `totalCents`. */
export function settlementStatusAfterPayment(totalCents: number, paidCents: number): SettlementStatus {
  if (paidCents <= 0) return 'ISSUED';
  return paidCents >= totalCents ? 'PAID' : 'PARTIALLY_PAID';
}

/** IBAN en grupos de 4 para leerlo y copiarlo: «ES91 2100 0418 4502 0005 1332». */
export function formatIbanGroups(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})(?=.)/g, '$1 ');
}

/** «Semana 44 de 2026». */
export function settlementWeekLabel(s: { isoYear: number; isoWeek: number }): string {
  return `Semana ${s.isoWeek} de ${s.isoYear}`;
}

const NIGHT_LABEL_FMT = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

/** «Noche del vie 30 oct» → «vie 30 oct» (el día de las 08:00 en que empieza; sin horas, no depende de la zona). */
export function settlementNightLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return NIGHT_LABEL_FMT.format(new Date(Date.UTC(y, m - 1, d, 12))).replace(/[.,]/g, '');
}
