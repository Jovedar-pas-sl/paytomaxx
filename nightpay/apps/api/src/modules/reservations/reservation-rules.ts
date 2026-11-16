import { randomBytes } from 'node:crypto';
import { reservationDepositCents, type ReservationPayKind, type ReservationStatus } from '@nightpay/contracts';
import { NIGHT_CUTOFF_HOUR, madridAt, madridDay, nextDay } from '../../common/time/madrid';

/**
 * Reglas de los reservados, sin base de datos (reservation-rules.spec.ts).
 *
 * La noche de una reserva es un día ("AAAA-MM-DD"): empieza a las 20:00 de
 * Madrid de ese día y acaba a las 08:00 del siguiente (el corte de la noche de
 * siempre). La reserva se guarda toda la noche (no se libera): «No vino» solo
 * después de que acabe.
 */

/** Hora en que empieza la noche (para el aviso de 48 h). */
export const RESERVATION_NIGHT_START_HOUR = 20;
/** El cliente cambia la fecha avisando con 48 h. */
export const CHANGE_NOTICE_MS = 48 * 60 * 60 * 1000;
/** Hasta cuántos días por delante se reserva. */
export const MAX_DAYS_AHEAD = 120;
/** Una reserva sin pagar ocupa sitio (tope por noche) solo un rato. */
export const PENDING_HOLD_MS = 30 * 60 * 1000;

/** Estados en los que la reserva cuenta (ocupa sitio y se puede pagar o usar). */
export const LIVE_STATUSES: ReadonlySet<ReservationStatus> = new Set(['DEPOSIT_PAID', 'PAID', 'ARRIVED']);

export function nightStart(nightDate: string): Date {
  return madridAt(nightDate, RESERVATION_NIGHT_START_HOUR);
}

export function nightEnd(nightDate: string): Date {
  return madridAt(nextDay(nightDate), NIGHT_CUTOFF_HOUR);
}

/** El día anterior a "AAAA-MM-DD". */
export function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Días entre dos fechas "AAAA-MM-DD" (b − a). */
export function daysBetween(a: string, b: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(b) - at(a)) / 86_400_000);
}

/** La noche en curso: antes de las 08:00 de Madrid, aún es la del día anterior. */
export function nightOf(now: Date): string {
  const today = madridDay(now);
  return now.getTime() < madridAt(today, NIGHT_CUTOFF_HOUR).getTime() ? previousDay(today) : today;
}

/** "AAAA-MM-DD" con forma y fecha de verdad (no 2026-02-31). */
export function isRealDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** ¿Se puede reservar esa noche ahora? (desde esta noche hasta MAX_DAYS_AHEAD) */
export function bookableNightProblem(nightDate: string, now: Date): string | null {
  if (!isRealDay(nightDate)) return 'Esa fecha no vale';
  const tonight = nightOf(now);
  const ahead = daysBetween(tonight, nightDate);
  if (ahead < 0) return 'Esa noche ya ha pasado';
  if (ahead > MAX_DAYS_AHEAD) return `Se reserva como mucho con ${MAX_DAYS_AHEAD} días`;
  return null;
}

export interface MoneyParts {
  priceCents: number;
  depositCents: number;
  restCents: number;
}

/** Señal (30 %) y resto (70 %) de un precio, en céntimos enteros. */
export function moneyParts(priceCents: number): MoneyParts {
  const depositCents = reservationDepositCents(priceCents);
  return { priceCents, depositCents, restCents: priceCents - depositCents };
}

export interface PayState {
  status: string;
  priceCents: number;
  depositCents: number;
  paidCents: number;
}

/** Lo que se puede pagar ahora: sin pagar, la señal o todo; con la señal, el resto. */
export function payableKinds(r: PayState): ReservationPayKind[] {
  if (r.status === 'PENDING' && r.paidCents === 0) return ['DEPOSIT', 'FULL'];
  if (r.status === 'DEPOSIT_PAID' && r.paidCents < r.priceCents) return ['REST'];
  return [];
}

/** Importe de un pago de ese tipo (null: ahora no toca). */
export function payAmount(r: PayState, kind: ReservationPayKind): number | null {
  if (!payableKinds(r).includes(kind)) return null;
  if (kind === 'DEPOSIT') return r.depositCents;
  if (kind === 'FULL') return r.priceCents;
  return r.priceCents - r.paidCents;
}

export type PaymentOutcome =
  | { ok: true; paidCents: number; status: 'DEPOSIT_PAID' | 'PAID'; fullyPaid: boolean }
  /** No cabe (ya estaba pagada, anulada, con la noche cerrada o paga de más): incidencia, el dinero queda en el saldo del grupo. */
  | { ok: false; reason: 'closed' | 'overpaid' };

/**
 * Un pago del banco (AUTHORIZED) a una reserva: suma y el estado nuevo. Solo
 * desde PENDING o DEPOSIT_PAID y sin pasar del precio.
 */
export function applyPaid(r: PayState, amountCents: number): PaymentOutcome {
  if (r.status !== 'PENDING' && r.status !== 'DEPOSIT_PAID') return { ok: false, reason: 'closed' };
  const paidCents = r.paidCents + amountCents;
  if (paidCents > r.priceCents) return { ok: false, reason: 'overpaid' };
  if (paidCents < r.depositCents) return { ok: false, reason: 'overpaid' };
  const fullyPaid = paidCents === r.priceCents;
  return { ok: true, paidCents, status: fullyPaid ? 'PAID' : 'DEPOSIT_PAID', fullyPaid };
}

/** Comisión del RRPP: su % del paquete, en céntimos enteros. */
export function promoterCommissionCents(priceCents: number, bps: number): number {
  return Math.round((priceCents * bps) / 10_000);
}

/** La comisión se gana cuando el paquete está pagado entero (una vez). */
export function commissionDue(r: { paidCents: number; priceCents: number; promoterId: string | null; commissionEarnedAt: Date | null }): boolean {
  return r.promoterId !== null && r.commissionEarnedAt === null && r.paidCents === r.priceCents;
}

export interface DateChangeState {
  status: string;
  nightDate: string;
  dateChangedAt: Date | null;
}

/** ¿Por qué no puede cambiar la fecha ahora? (null: puede) */
export function clientChangeBlocker(r: DateChangeState, now: Date): string | null {
  if (r.status !== 'DEPOSIT_PAID' && r.status !== 'PAID') return 'Esta reserva ya no se puede cambiar';
  if (r.dateChangedAt) return 'La fecha solo se puede cambiar una vez';
  if (now.getTime() > nightStart(r.nightDate).getTime() - CHANGE_NOTICE_MS) {
    return 'La fecha se cambia avisando con 48 horas';
  }
  return null;
}

/**
 * ¿Puede el cliente cambiar la fecha? Una sola vez, con la reserva pagada (al
 * menos la señal) y avisando con 48 h antes de que empiece la noche.
 */
export function clientChangeProblem(r: DateChangeState, newDate: string, now: Date): string | null {
  const blocked = clientChangeBlocker(r, now);
  if (blocked) return blocked;
  if (newDate === r.nightDate) return 'Elige otra noche';
  return bookableNightProblem(newDate, now);
}

/** ¿Se puede dar la llegada? Pagado entero y en su noche (desde la víspera por si llegan pronto). */
export function arrivalProblem(r: { status: string; paidCents: number; priceCents: number; nightDate: string }, now: Date): string | null {
  if (r.status === 'ARRIVED') return 'Ya ha llegado';
  if (r.status !== 'PAID' && r.status !== 'DEPOSIT_PAID') return 'Esta reserva no está pagada';
  if (r.paidCents < r.priceCents) return 'Falta por pagar el resto';
  if (nightOf(now) !== r.nightDate) return `Esta reserva es de la noche del ${r.nightDate}`;
  return null;
}

export interface NoShowOutcome {
  /** La señal: pasa a venta, no se devuelve. */
  lostCents: number;
  /** Lo pagado de más (el 70 % si pagó todo): queda como saldo para otra noche. */
  leftCents: number;
}

/** «No vino»: solo después de su noche y con algo pagado. */
export function noShowProblem(r: { status: string; nightDate: string }, now: Date): string | null {
  if (r.status !== 'DEPOSIT_PAID' && r.status !== 'PAID') return 'Esta reserva no está pendiente de llegar';
  if (now.getTime() < nightEnd(r.nightDate).getTime()) return 'La reserva se guarda toda la noche: márcala cuando acabe';
  return null;
}

export function noShowOutcome(r: { depositCents: number; paidCents: number }): NoShowOutcome {
  const lostCents = Math.min(r.depositCents, r.paidCents);
  return { lostCents, leftCents: r.paidCents - lostCents };
}

/** Lo que pasa a venta al llegar: el paquete menos el importe para consumir (que queda en el saldo del grupo). */
export function arrivalSaleCents(r: { priceCents: number; creditCents: number }): number {
  return r.priceCents - r.creditCents;
}

export interface ItemLine {
  name: string;
  qty: number;
}

/** Lo que queda de cada cosa del paquete después de lo servido. */
export function itemsLeft(items: readonly ItemLine[], served: readonly ItemLine[]): Array<ItemLine & { left: number }> {
  return items.map((it) => {
    const used = served.filter((s) => s.name === it.name).reduce((a, s) => a + s.qty, 0);
    return { ...it, left: Math.max(0, it.qty - used) };
  });
}

/** Los items guardados (JSON) como lista limpia. */
export function itemsOf(raw: unknown): ItemLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const o = x as { name?: unknown; qty?: unknown };
    return typeof o?.name === 'string' && typeof o.qty === 'number' ? [{ name: o.name, qty: o.qty }] : [];
  });
}

// ─── Códigos ──────────────────────────────────────────────────────────

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Referencia corta para el personal (6 letras y cifras, sin 0/O ni 1/I). */
export function newReservationRef(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

/** El enlace del que reservó (192 bits). */
export function newManageToken(): string {
  return randomBytes(24).toString('base64url');
}

/** El QR de una persona del grupo (144 bits). */
export function newGuestToken(): string {
  return randomBytes(18).toString('base64url');
}

/** El código del enlace del local para reservar (16 letras). */
export function newReservationsCode(): string {
  return randomBytes(12).toString('base64url');
}

/** El código del enlace de un RRPP (12 letras). */
export function newPromoterCode(): string {
  return randomBytes(9).toString('base64url');
}

export function isReservationsCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{16}$/.test(code);
}

export function isPromoterCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{12}$/.test(code);
}

export function isManageToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);
}

/** El QR de una persona: su token, o la URL entera (…/reservas/q/<token>). */
export function guestTokenFrom(raw: string): string | null {
  const trimmed = raw.trim();
  const m = /(?:^|\/q\/)([A-Za-z0-9_-]{24})(?:[?#].*)?$/.exec(trimmed);
  return m?.[1] ?? null;
}

/** Fecha de la base (DATE) como "AAAA-MM-DD". */
export function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "AAAA-MM-DD" para guardar en una columna DATE. */
export function dateOfDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
