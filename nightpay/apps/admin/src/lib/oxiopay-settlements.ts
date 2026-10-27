// «Liquidación OxioPay» en el panel (dueño, solo lectura) y en la consola del
// super-admin: textos, estados, el desglose para las tablas y el formulario
// de «Apuntar pago». Lógica pura (sin React): se prueba sola. Las reglas del
// pago (más de lo pendiente no; distinto, con motivo) son las del API
// (settlementPaymentProblem, @nightpay/contracts).

import {
  SETTLEMENT_CONCEPTS,
  SETTLEMENT_CONCEPT_HELP,
  SETTLEMENT_CONCEPT_LABELS,
  SETTLEMENT_STATUS_LABELS,
  formatIbanGroups,
  parseEuroCents,
  settlementNightLabel,
  settlementPaymentProblem,
  settlementWeekLabel,
  type OwnerSettlementNotice,
  type OxioPayPayee,
  type SettlementConcept,
  type SettlementDetail,
  type SettlementListItem,
  type SettlementStatusFilter,
} from '@nightpay/contracts';
import { ApiError } from './api-errors';
import { dayInZone, MADRID_TIMEZONE } from './dates';
import { centsToInput, formatEur } from './money';
import { toQueryString } from './superadmin/query';

export type SettlementTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Estado con su color: anulada gris; pagada verde; en parte ámbar; sin pagar 7 días, rojo. */
export function settlementStatusView(s: Pick<SettlementListItem, 'status' | 'overdue' | 'daysOpen'>): { label: string; tone: SettlementTone } {
  if (s.status === 'VOID') return { label: SETTLEMENT_STATUS_LABELS.VOID, tone: 'neutral' };
  if (s.status === 'PAID') return { label: SETTLEMENT_STATUS_LABELS.PAID, tone: 'success' };
  const base = SETTLEMENT_STATUS_LABELS[s.status];
  if (s.overdue) return { label: `${base} · ${s.daysOpen} días sin pagar`, tone: 'danger' };
  return { label: base, tone: s.status === 'PARTIALLY_PAID' ? 'warning' : 'info' };
}

/** «Semana 44 de 2026 · lun 26 oct → lun 2 nov (08:00)». */
export function settlementPeriodText(s: Pick<SettlementListItem, 'isoYear' | 'isoWeek' | 'periodFrom' | 'periodTo'>): string {
  const day = (iso: string) => settlementNightLabel(dayInZone(new Date(iso), MADRID_TIMEZONE));
  return `${settlementWeekLabel(s)} · ${day(s.periodFrom)} → ${day(s.periodTo)} (08:00)`;
}

export interface ConceptRow {
  concept: SettlementConcept;
  label: string;
  help: string;
  cents: number;
}

/** Lo que entra en la liquidación por concepto (semana + ajustes), sin los que están a 0. */
export function conceptRows(d: Pick<SettlementDetail, 'byConcept'>): ConceptRow[] {
  return SETTLEMENT_CONCEPTS.filter((c) => d.byConcept[c] !== 0).map((c) => ({
    concept: c,
    label: SETTLEMENT_CONCEPT_LABELS[c],
    help: SETTLEMENT_CONCEPT_HELP[c],
    cents: d.byConcept[c],
  }));
}

/** Las columnas de la tabla por noche: los conceptos con algo en alguna noche. */
export function nightColumns(d: Pick<SettlementDetail, 'nights'>): SettlementConcept[] {
  return SETTLEMENT_CONCEPTS.filter((c) => d.nights.some((n) => n.concepts[c] !== 0));
}

export const nightLabel = settlementNightLabel;

/** Lo que hay que poner en la transferencia (para copiarlo de una vez). */
export function transferText(d: Pick<SettlementDetail, 'reference' | 'pendingCents'>, payee: OxioPayPayee): string {
  return [
    `Titular: ${payee.holder}`,
    `IBAN: ${formatIbanGroups(payee.iban)}`,
    `Concepto: ${d.reference}`,
    `Importe: ${formatEur(d.pendingCents)}`,
  ].join('\n');
}

// ─── Apuntar un pago (consola) ───────────────────────────────────────

export interface PaymentForm {
  /** Lo que se teclea («22,35»). */
  amount: string;
  /** AAAA-MM-DD del abono en el banco. */
  paidOn: string;
  bankReference: string;
  reason: string;
}

/** De entrada, lo pendiente y hoy. */
export function paymentFormFor(d: Pick<SettlementDetail, 'pendingCents'>, today: string): PaymentForm {
  return { amount: centsToInput(d.pendingCents), paidOn: today, bankReference: '', reason: '' };
}

export type PaymentPayload = { amountCents: number; paidOn: string; bankReference: string; reason?: string; confirmDuplicate?: boolean };

/** ¿El importe tecleado es distinto de lo pendiente? (entonces el motivo es obligatorio). */
export function paymentMismatch(form: PaymentForm, pendingCents: number): boolean {
  const cents = parseEuroCents(form.amount);
  return cents !== null && cents !== pendingCents;
}

/**
 * El cuerpo de «Apuntar pago». `confirmDuplicate`: ya hay un pago con esa
 * referencia del banco (409 SETTLEMENT_PAYMENT_DUPLICATE) y es otro abono.
 */
export function paymentPayload(
  form: PaymentForm,
  pendingCents: number,
  today: string,
  confirmDuplicate = false,
): { ok: true; value: PaymentPayload } | { ok: false; error: string } {
  const amountCents = parseEuroCents(form.amount);
  if (amountCents === null) return { ok: false, error: 'Pon el importe recibido (por ejemplo 22,35).' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.paidOn)) return { ok: false, error: 'Pon el día del abono en el banco.' };
  if (form.paidOn > today) return { ok: false, error: 'El día del abono no puede ser futuro.' };
  const bankReference = form.bankReference.trim();
  if (!bankReference) return { ok: false, error: 'Pon la referencia del banco (la del movimiento).' };
  if (bankReference.length > 140) return { ok: false, error: 'La referencia del banco, como mucho 140 caracteres.' };
  const reason = form.reason.trim();
  const problem = settlementPaymentProblem({ pendingCents, amountCents, reason });
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    value: { amountCents, paidOn: form.paidOn, bankReference, ...(reason ? { reason } : {}), ...(confirmDuplicate ? { confirmDuplicate: true } : {}) },
  };
}

/** Frase de confirmación del pago (antes del código 2FA). */
export function paymentSummary(d: Pick<SettlementDetail, 'reference' | 'pendingCents'>, amountCents: number): string {
  if (amountCents === d.pendingCents) return `Vas a apuntar ${formatEur(amountCents)} recibidos de ${d.reference}: queda pagada entera.`;
  return `Vas a apuntar ${formatEur(amountCents)} recibidos de ${d.reference}: quedan ${formatEur(d.pendingCents - amountCents)} pendientes.`;
}

// ─── Filtros de la consola ───────────────────────────────────────────

export interface SettlementFilters {
  venueId: string;
  businessId: string;
  status: SettlementStatusFilter | '';
  /** Semanas que empiezan desde / hasta (AAAA-MM-DD). */
  from: string;
  to: string;
  q: string;
}

export const EMPTY_SETTLEMENT_FILTERS: SettlementFilters = { venueId: '', businessId: '', status: 'OPEN', from: '', to: '', q: '' };

export function settlementsQuery(f: SettlementFilters): string {
  return toQueryString({ venueId: f.venueId, businessId: f.businessId, status: f.status, from: f.from, to: f.to, q: f.q });
}

export const SETTLEMENT_STATUS_FILTERS: ReadonlyArray<{ value: SettlementStatusFilter | ''; label: string }> = [
  { value: 'OPEN', label: 'Pendientes (emitidas y en parte)' },
  { value: '', label: 'Todas' },
  { value: 'ISSUED', label: SETTLEMENT_STATUS_LABELS.ISSUED },
  { value: 'PARTIALLY_PAID', label: SETTLEMENT_STATUS_LABELS.PARTIALLY_PAID },
  { value: 'PAID', label: SETTLEMENT_STATUS_LABELS.PAID },
  { value: 'VOID', label: SETTLEMENT_STATUS_LABELS.VOID },
];

// ─── Aviso del panel del dueño ───────────────────────────────────────

/** Lo que dice el aviso de arriba del panel; null si no hay nada que avisar. */
export function overdueNoticeText(n: OwnerSettlementNotice | null): string | null {
  if (!n || n.overdue.length === 0) return null;
  const oldest = n.overdue.reduce((a, b) => (b.daysOpen > a.daysOpen ? b : a));
  if (n.overdue.length === 1) {
    return `La liquidación OxioPay ${oldest.reference} lleva ${oldest.daysOpen} días sin pagar: faltan ${formatEur(oldest.pendingCents)}.`;
  }
  return `Tienes ${n.overdue.length} liquidaciones OxioPay con más de 7 días sin pagar: faltan ${formatEur(n.overdueCents)} en total.`;
}

/** Nombre del archivo al guardar el documento o el CSV (como el API). */
export function settlementFileName(reference: string, ext: 'html' | 'csv'): string {
  return `liquidacion-oxiopay-${reference}.${ext}`;
}

// ─── Generar una semana (consola) ────────────────────────────────────

/** Por qué no vale el lunes elegido; null si vale (lunes y semana ya terminada). */
export function weekStartProblem(day: string, today: string, startWeek: string | null = null): string | null {
  const notMonday = mondayProblem(day);
  if (notMonday) return notMonday;
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  if (end > today) return 'Esa semana aún no ha terminado (acaba el lunes siguiente a las 08:00).';
  if (startWeek && day < startWeek) return `Esa semana es anterior a la semana de inicio de las liquidaciones (lunes ${startWeek}): no se liquida.`;
  return null;
}

/** AAAA-MM-DD que sea un lunes de verdad; null si vale. */
export function mondayProblem(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'Elige el lunes en que empieza la semana.';
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCDate() !== d) return 'Elige el lunes en que empieza la semana.';
  if (date.getUTCDay() !== 1) return 'La semana de la liquidación empieza en lunes: elige un lunes.';
  return null;
}

/** La frase de confirmación al fijar o cambiar la semana de inicio. */
export function startWeekSummary(next: string, current: string | null): string {
  const tail = 'no se liquidará nada anterior a esa semana.';
  return current
    ? `Vas a cambiar la semana de inicio del lunes ${current} al lunes ${next}: ${tail}`
    : `Vas a fijar la semana de inicio en el lunes ${next}: ${tail}`;
}

/** El API dice que esa referencia del banco ya está apuntada en esta liquidación (hay que confirmar que es otro abono). */
export function isDuplicatePaymentError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'SETTLEMENT_PAYMENT_DUPLICATE';
}

/** El lunes de la semana anterior a la de hoy (la última terminada), para empezar. */
export function lastMondayBefore(today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = ((date.getUTCDay() + 6) % 7) + 7;
  return new Date(date.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}
