import type { MyDebt, MyEarning, MyNight, OperatorBalance } from './api';
import { formatBps, formatEur } from './money';

/**
 * «Ganancias» de la chica: ¿cuánto y cuándo? Lo que se le paga al cerrar la
 * noche, lo que quedó de otras noches, lo que está en espera y lo que se le
 * descuenta por devoluciones. Sin React: se prueba en money/earnings-view.test.
 */

const MADRID_TZ = 'Europe/Madrid';
const DAY_MS = 86_400_000;
/** Las noches cambian a las 08:00 de Madrid (como el cierre automático de la noche). */
const NIGHT_ROLLOVER_MS = 8 * 3_600_000;

const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: MADRID_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_LABEL = new Intl.DateTimeFormat('es-ES', { timeZone: MADRID_TZ, weekday: 'short', day: 'numeric', month: 'short' });
const TIME_LABEL = new Intl.DateTimeFormat('es-ES', { timeZone: MADRID_TZ, hour: '2-digit', minute: '2-digit' });

/** «sáb 12 oct» (hora de Madrid). */
export function dayLabel(at: string | number | Date): string {
  return DAY_LABEL.format(new Date(at)).replace(/,/g, '').replace(/\.(?=\s|$)/g, '');
}

/** «23:40» (hora de Madrid). */
export function timeLabel(at: string | number | Date): string {
  return TIME_LABEL.format(new Date(at));
}

const PAYMENT_TIME = new Intl.DateTimeFormat('es-ES', {
  timeZone: MADRID_TZ,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** «13 oct, 00:40» de «Cobros» (hora de Madrid, como el resto; no la del móvil). */
export function paymentTimeLabel(at: string | number | Date): string {
  return PAYMENT_TIME.format(new Date(at));
}

/** La noche de un cobro, como «AAAA-MM-DD» del día en que empezó (un cobro a las 03:00 es de la noche anterior). */
export function serviceNightKey(at: string): string {
  return DAY_KEY.format(new Date(Date.parse(at) - NIGHT_ROLLOVER_MS));
}

/** «sáb 12 oct» de una noche («AAAA-MM-DD»). */
export function nightLabel(key: string): string {
  return dayLabel(`${key}T12:00:00Z`);
}

/** ¿El cobro es de la noche que ve la chica? (desde que se abrió hasta su cierre, o hasta ahora). */
export function isInNight(e: { createdAt: string }, night: Pick<MyNight, 'from' | 'to'>): boolean {
  const t = Date.parse(e.createdAt);
  return t >= Date.parse(night.from) && (night.to === null || t < Date.parse(night.to));
}

export const sumNet = (earnings: readonly MyEarning[]): number => earnings.reduce((sum, e) => sum + e.netCents, 0);

/** Lo que dice el total y no sale en la lista (la lista trae los últimos cobros, no todos). */
export function unlistedCents(totalCents: number, listedCents: number): number {
  return Math.max(0, totalCents - listedCents);
}

// ─── Las cifras de arriba ─────────────────────────────────────────

export interface MoneySummary {
  /** «Esta noche»: su parte (comisión + propinas − devoluciones). */
  tonightCents: number;
  /** De esta noche, lo que aún no le han pagado. */
  tonightUnpaidCents: number;
  /** Noche cerrada y su parte ya pagada. */
  tonightPaid: boolean;
  /** Ganado en otras noches y aún sin pagar. */
  otherNightsCents: number;
  /** En espera (aún no entra en un pago). */
  heldCents: number;
  /** Pendiente de cuadrar con el banco (ventas por datáfono): no entra en un pago hasta cuadrarlas. */
  bankHeldCents: number;
  /** Devoluciones tras un pago: se descuentan del próximo. */
  debtCents: number;
  /** Lo que entra en el próximo pago (nunca negativo); null sin saldo cargado. */
  nextPayoutCents: number | null;
  /** Debe más de lo que tiene a cobrar: lo que queda por descontar después. */
  owedAfterCents: number;
}

/**
 * Junta la noche (/nights/mine) y el saldo (/operators/me/balance). Con un
 * API antiguo sin el reparto de lo pendiente, lo de esta noche se da por no
 * pagado y lo de otras noches es el resto de lo pendiente.
 */
export function moneySummary(night: MyNight | null, balance: OperatorBalance | null): MoneySummary {
  const tonight = night?.netCents ?? 0;
  const debt = Math.max(0, balance?.debtCents ?? 0);
  const held = Math.max(0, balance?.heldCents ?? 0);
  const bankHeld = Math.max(0, balance?.bankHeldCents ?? 0);
  const tonightUnpaid = night?.unpaidCents ?? Math.max(0, tonight);
  const unpaidAll = balance ? balance.pendingCents + debt : null;
  const other = night?.otherUnpaidCents ?? (unpaidAll === null ? 0 : Math.max(0, unpaidAll - tonightUnpaid));
  const available = balance ? (balance.availableCents ?? balance.pendingCents) : null;
  return {
    tonightCents: tonight,
    tonightUnpaidCents: tonightUnpaid,
    tonightPaid: Boolean(night && night.to !== null && tonight > 0 && tonightUnpaid <= 0),
    otherNightsCents: other,
    heldCents: held,
    bankHeldCents: bankHeld,
    debtCents: debt,
    nextPayoutCents: available === null ? null : Math.max(0, available),
    owedAfterCents: available === null ? 0 : Math.max(0, -available),
  };
}

export type TonightTone = 'open' | 'closed' | 'paid' | 'none';

export interface TonightStatus {
  /** «Noche abierta · desde las 22:00», «Noche cerrada a las 06:12»… */
  state: string;
  /** Cuándo se lo pagan. */
  when: string;
  tone: TonightTone;
}

/**
 * El estado de la noche y cuándo se cobra. Sin días de espera (lo normal: se
 * paga cada noche) «al cerrar la noche»; con espera, a partir de qué día.
 * holdDays null: no se sabe (sin /me/payout-info); si hay algo en espera, se dice sin fecha.
 */
export function tonightStatus(night: MyNight, summary: MoneySummary, holdDays: number | null, now: number): TonightStatus {
  const hold = holdDays ?? (summary.heldCents > 0 ? null : 0);
  const paidOn = (fromMs: number) =>
    hold === null ? 'Te lo pagan cuando pasen los días de espera' : `Te lo pagan a partir del ${dayLabel(fromMs + hold * DAY_MS)}`;

  if (night.nightOpen) {
    return {
      state: `Noche abierta · desde las ${timeLabel(night.from)}`,
      when: hold === 0 ? 'Te lo pagan al cerrar la noche' : paidOn(now),
      tone: 'open',
    };
  }
  if (night.to !== null) {
    const state = `Noche cerrada a las ${timeLabel(night.to)}`;
    if (summary.tonightPaid) return { state, when: 'Ya te lo han pagado', tone: 'paid' };
    if (summary.tonightUnpaidCents <= 0) return { state, when: 'No hay nada que pagarte de esta noche', tone: 'closed' };
    return { state, when: hold === 0 ? 'Pendiente de pago' : paidOn(Date.parse(night.to)), tone: 'closed' };
  }
  return {
    state: `Sin noche abierta · desde las ${timeLabel(night.from)}`,
    when: hold === 0 ? 'Te lo pagan al cerrar la noche' : paidOn(now),
    tone: 'none',
  };
}

/** «3 cobros · +20 € de propinas · −12 € por devoluciones». */
export function tonightBreakdown(night: Pick<MyNight, 'count' | 'tipsCents' | 'reversedCents'>): string {
  const parts = [`${night.count} ${night.count === 1 ? 'cobro' : 'cobros'}`];
  if (night.tipsCents > 0) parts.push(`+${formatEur(night.tipsCents, { compact: true })} de propinas`);
  if (night.reversedCents > 0) parts.push(`−${formatEur(night.reversedCents, { compact: true })} por devoluciones`);
  return parts.join(' · ');
}

// ─── Las listas del detalle ───────────────────────────────────────

/** «37,5 % de 120 € · +5 € propina · devolución −12 €» (o «Del saldo» si no fue con tarjeta). */
export function earningDetail(e: MyEarning): string {
  const source = e.paymentId ? '' : ' del saldo';
  // Un servicio que le cobraron a su nombre: su % de lo suyo, no del total con la copa.
  const bps = e.serviceBps ?? e.commissionBps;
  const base = e.serviceBaseCents ?? e.paymentAmountCents;
  const parts = [`${formatBps(bps)} de ${formatEur(base, { compact: true })}${source}`];
  if ((e.tipCents ?? 0) > 0) parts.push(`+${formatEur(e.tipCents ?? 0, { compact: true })} propina`);
  if (e.reversedCents > 0) parts.push(`devolución −${formatEur(e.reversedCents, { compact: true })}`);
  return parts.join(' · ');
}

/** «No es mío» de una fila: quién le cobró el servicio y si ya avisó (null: lo cobró ella, o es una invitación). */
export function notMineView(e: Pick<MyEarning, 'servedByName' | 'notMineReported'>): { by: string; reported: boolean } | null {
  return e.servedByName ? { by: e.servedByName, reported: e.notMineReported === true } : null;
}

export function tonightEarnings(earnings: readonly MyEarning[], night: MyNight | null): MyEarning[] {
  return night ? earnings.filter((e) => isInNight(e, night)) : [];
}

/** Lo no pagado que no es de esta noche. */
export function otherNightsUnpaid(earnings: readonly MyEarning[], night: MyNight | null): MyEarning[] {
  return earnings.filter((e) => e.payoutId === null && !(night && isInNight(e, night)));
}

export interface NightGroup {
  key: string;
  /** «sáb 12 oct». */
  label: string;
  totalCents: number;
  earnings: MyEarning[];
}

/** Por noches, de la más reciente a la más antigua (y cada noche, del último cobro al primero). */
export function groupByNight(earnings: readonly MyEarning[]): NightGroup[] {
  const sorted = [...earnings].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const groups = new Map<string, MyEarning[]>();
  for (const e of sorted) {
    const key = serviceNightKey(e.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    label: nightLabel(key),
    totalCents: sumNet(items),
    earnings: items,
  }));
}

export interface HeldItem {
  earning: MyEarning;
  /** Desde cuándo entra en un pago. */
  releaseAt: string;
}

/**
 * Lo que está en espera y el día en que deja de estarlo, del primero que sale
 * al último. Lo pendiente de cuadrar con el banco va aparte (bankHeldItems):
 * no sale de ahí al pasar los días.
 */
export function heldItems(earnings: readonly MyEarning[], holdDays: number, now: number): HeldItem[] {
  if (holdDays <= 0) return [];
  return earnings
    .filter((e) => e.payoutId === null && !e.bankHeld && Date.parse(e.createdAt) + holdDays * DAY_MS > now)
    .map((e) => ({ earning: e, releaseAt: new Date(Date.parse(e.createdAt) + holdDays * DAY_MS).toISOString() }))
    .sort((a, b) => Date.parse(a.releaseAt) - Date.parse(b.releaseAt));
}

/** Pendiente de cuadrar con el banco: sus cobros por datáfono sin pagar retenidos, del más antiguo al más nuevo. */
export function bankHeldItems(earnings: readonly MyEarning[]): MyEarning[] {
  return earnings
    .filter((e) => e.payoutId === null && e.bankHeld === true)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Hasta cuándo hay algo en espera (lo último que sale). */
export function heldUntil(items: readonly HeldItem[]): string | null {
  return items.length > 0 ? items[items.length - 1]!.releaseAt : null;
}

/** Las que aún se le van a descontar y las ya descontadas en un pago. */
export function splitDebts(debts: readonly MyDebt[]): { open: MyDebt[]; settled: MyDebt[] } {
  return {
    open: debts.filter((d) => d.settledPayoutId === null),
    settled: debts.filter((d) => d.settledPayoutId !== null),
  };
}
