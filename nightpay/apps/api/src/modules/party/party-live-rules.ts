import {
  ORGANIZER_OWN_BAR_BPS,
  type PartyAlert,
  type PartyDesk,
  type PartyHour,
  type PartyLive,
  type PartyLiveScope,
  type PartyNight,
  type PartyStallLive,
} from '@nightpay/contracts';
import { fillHours } from '../../common/time/hour-fill';
import type { PartyWindow } from './party-windows';

/**
 * El panel en directo de OxioParty (lógica pura): de las filas sumadas en la
 * base (party-live.service) a lo que enseña el panel. Vendido = cobros que no
 * son recargas + consumos del saldo no anulados − lo devuelto de esos cobros
 * (las reglas del mapa del dinero: las recargas son «cargado», nunca venta).
 */

const MINUTE_MS = 60_000;
/** Como mucho dos semanas de horas en la gráfica (las últimas). */
export const MAX_PARTY_HOURS = 24 * 14;

/** Lo vendido de una caseta (o sin caseta) en una hora: cobros y consumos, y lo devuelto en negativo. */
export interface StallHourRow {
  stallId: string | null;
  /** Hora desde 1970 (floor(epoch / 3600)). */
  hour: number;
  cents: number;
  count: number;
  lastAt: Date | null;
  refundedCents: number;
  lastHourCents: number;
}

export interface StallMeta {
  id: string;
  name: string;
  managerName: string;
  managerContact: string | null;
  organizerBps: number;
  active: boolean;
  sortOrder: number;
}

/** Recargas con tarjeta sumadas por quién las cobró (una persona, el datáfono de recepción o el móvil del asistente). */
export interface CardTopUpRow {
  kind: 'person' | 'terminal' | 'phone';
  who: string | null;
  cents: number;
  count: number;
  lastHourCents: number;
}

/** Recargas en efectivo por quién las cobró (las anulaciones, negativas, restan). */
export interface CashTopUpRow {
  kind: 'person' | 'terminal';
  who: string;
  cents: number;
  feeCents: number;
  count: number;
  lastHourCents: number;
}

/** Saldo devuelto en efectivo por persona. */
export interface CashPayoutRow {
  who: string;
  cents: number;
  count: number;
}

export interface StallTotals {
  stallId: string | null;
  cents: number;
  count: number;
  lastAt: Date | null;
  refundedCents: number;
  lastHourCents: number;
}

/** Las filas por caseta y hora, sumadas por caseta. */
export function totalsByStall(rows: readonly StallHourRow[]): Map<string | null, StallTotals> {
  const out = new Map<string | null, StallTotals>();
  for (const r of rows) {
    const cur = out.get(r.stallId) ?? { stallId: r.stallId, cents: 0, count: 0, lastAt: null, refundedCents: 0, lastHourCents: 0 };
    out.set(r.stallId, {
      stallId: r.stallId,
      cents: cur.cents + r.cents,
      count: cur.count + r.count,
      lastAt: later(cur.lastAt, r.lastAt),
      refundedCents: cur.refundedCents + r.refundedCents,
      lastHourCents: cur.lastHourCents + r.lastHourCents,
    });
  }
  return out;
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return b.getTime() > a.getTime() ? b : a;
}

/**
 * Las horas de la gráfica, seguidas (las que no tienen nada, a 0): de la
 * primera con ventas a la de `to` (en directo) o a la última con ventas.
 * La de ahora, `open`. Como mucho MAX_PARTY_HOURS (las últimas).
 */
export function hourlyOf(rows: readonly StallHourRow[], window: PartyWindow): PartyHour[] {
  const byHour = new Map<number, number>();
  for (const r of rows) byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.cents);
  return fillHours(byHour, window, MAX_PARTY_HOURS).map((h) => ({ at: h.at, soldCents: h.cents, open: h.open }));
}

export interface StallsInput {
  meta: readonly StallMeta[];
  totals: Map<string | null, StallTotals>;
  now: Date;
  idleMinutes: number;
  /** En directo y con la fiesta en marcha: solo entonces hay avisos de casetas paradas. */
  watchIdle: boolean;
}

/**
 * Las casetas por lo vendido (de más a menos; a igualdad, su orden y su
 * nombre), con «Sin caseta» al final si vendió algo. Salen las activas y
 * las desactivadas con algo en la ventana. Una caseta está «parada» si ya
 * cobró en la ventana, lleva `idleMinutes` sin cobrar y otra caseta sí ha
 * cobrado en ese rato (la fiesta sigue): sin latido de conexión, no se
 * sabe más.
 */
export function stallsOf(i: StallsInput): PartyStallLive[] {
  const idleMs = i.idleMinutes * MINUTE_MS;
  const since = i.now.getTime() - idleMs;
  const partyGoing = [...i.totals.values()].some((t) => t.lastAt !== null && t.lastAt.getTime() >= since);
  const rows = i.meta
    .filter((s) => s.active || hasActivity(i.totals.get(s.id)))
    .map((s): PartyStallLive & { sortOrder: number } => {
      const t = i.totals.get(s.id);
      const lastAt = t?.lastAt ?? null;
      const idle = i.watchIdle && partyGoing && s.active && lastAt !== null && lastAt.getTime() < since;
      return {
        id: s.id,
        name: s.name,
        managerName: s.managerName,
        managerContact: s.managerContact,
        organizerBps: s.organizerBps,
        ownBar: s.organizerBps === ORGANIZER_OWN_BAR_BPS,
        active: s.active,
        soldCents: t?.cents ?? 0,
        count: t?.count ?? 0,
        lastAt: lastAt?.toISOString() ?? null,
        idle,
        sortOrder: s.sortOrder,
      };
    })
    .sort((a, b) => b.soldCents - a.soldCents || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es'))
    .map(({ sortOrder: _sortOrder, ...rest }) => rest);
  const none = i.totals.get(null);
  if (!hasActivity(none)) return rows;
  return [
    ...rows,
    {
      id: null,
      name: 'Sin caseta',
      managerName: null,
      managerContact: null,
      organizerBps: null,
      ownBar: false,
      active: true,
      soldCents: none?.cents ?? 0,
      count: none?.count ?? 0,
      lastAt: none?.lastAt?.toISOString() ?? null,
      idle: false,
    },
  ];
}

function hasActivity(t: StallTotals | undefined): boolean {
  return Boolean(t && (t.count > 0 || t.cents !== 0));
}

export interface DesksInput {
  card: readonly CardTopUpRow[];
  cash: readonly CashTopUpRow[];
  payouts: readonly CashPayoutRow[];
  /** Nombre de cada persona (displayName o correo) y de cada datáfono. */
  people: ReadonlyMap<string, string>;
  terminals: ReadonlyMap<string, string>;
}

/**
 * Las taquillas: cada persona o datáfono de recepción con lo que cargó en
 * efectivo y con tarjeta y el efectivo de su caja; y «Desde el móvil» (lo que
 * cargan los asistentes) al final. De más a menos cargado.
 */
export function desksOf(i: DesksInput): PartyDesk[] {
  const desks = new Map<string, PartyDesk>();
  const desk = (kind: 'person' | 'terminal', who: string): PartyDesk => {
    const key = `${kind}:${who}`;
    const found = desks.get(key);
    if (found) return found;
    const name = kind === 'person' ? (i.people.get(who) ?? 'Persona sin nombre') : (i.terminals.get(who) ?? 'Datáfono de recepción');
    const created: PartyDesk = { key, kind, name, cashCents: 0, cardCents: 0, cashInDeskCents: 0, count: 0 };
    desks.set(key, created);
    return created;
  };
  let phone: PartyDesk | null = null;
  for (const r of i.card) {
    if (r.kind === 'phone' || !r.who) {
      phone = phone ?? { key: 'phone', kind: 'phone', name: 'Desde el móvil', cashCents: 0, cardCents: 0, cashInDeskCents: 0, count: 0 };
      phone.cardCents += r.cents;
      phone.count += r.count;
      continue;
    }
    const d = desk(r.kind, r.who);
    d.cardCents += r.cents;
    d.count += r.count;
  }
  for (const r of i.cash) {
    const d = desk(r.kind, r.who);
    d.cashCents += r.cents;
    d.cashInDeskCents += r.cents + r.feeCents;
    d.count += r.count;
  }
  for (const p of i.payouts) desk('person', p.who).cashInDeskCents -= p.cents;
  const sorted = [...desks.values()].sort(
    (a, b) => b.cashCents + b.cardCents - (a.cashCents + a.cardCents) || a.name.localeCompare(b.name, 'es'),
  );
  return phone ? [...sorted, phone] : sorted;
}

/**
 * Los avisos (solo en la noche en curso): el efectivo de una taquilla por
 * encima del umbral del local (0: sin aviso) y las casetas paradas. El de
 * efectivo primero (es dinero suelto), de más a menos.
 */
export function alertsOf(args: {
  desks: readonly PartyDesk[];
  stalls: readonly PartyStallLive[];
  cashAlertCents: number;
  now: Date;
  watch: boolean;
}): PartyAlert[] {
  if (!args.watch) return [];
  const cash: PartyAlert[] =
    args.cashAlertCents > 0
      ? args.desks
          .filter((d) => d.kind !== 'phone' && d.cashInDeskCents > args.cashAlertCents)
          .sort((a, b) => b.cashInDeskCents - a.cashInDeskCents)
          .map((d) => ({ kind: 'CASH_OVER', deskKey: d.key, name: d.name, cashCents: d.cashInDeskCents, thresholdCents: args.cashAlertCents }))
      : [];
  const idle: PartyAlert[] = args.stalls
    .filter((s): s is PartyStallLive & { id: string; lastAt: string; managerName: string } => s.idle && s.id !== null && s.lastAt !== null)
    .map((s) => ({
      kind: 'STALL_IDLE',
      stallId: s.id,
      name: s.name,
      minutes: Math.floor((args.now.getTime() - Date.parse(s.lastAt)) / MINUTE_MS),
      managerName: s.managerName,
      managerContact: s.managerContact,
    }));
  return [...cash, ...idle];
}

export interface PartyLiveInput {
  scope: PartyLiveScope;
  night: string | null;
  window: PartyWindow;
  now: Date;
  idleMinutes: number;
  event: { name: string; startsAt: Date | null; endsAt: Date | null; ended: boolean; nights: PartyNight[] };
  cashAlertCents: number;
  stallMeta: readonly StallMeta[];
  sales: readonly StallHourRow[];
  card: readonly CardTopUpRow[];
  cash: readonly CashTopUpRow[];
  payouts: readonly CashPayoutRow[];
  people: ReadonlyMap<string, string>;
  terminals: ReadonlyMap<string, string>;
  wristbands: { balanceCents: number; active: number };
}

const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

export function buildPartyLive(i: PartyLiveInput): PartyLive {
  const totals = totalsByStall(i.sales);
  const totalList = [...totals.values()];
  // Los avisos y las casetas paradas: solo en la noche de ahora y con la fiesta en marcha.
  const watch = i.scope === 'night' && i.window.live && !i.event.ended;
  const stalls = stallsOf({ meta: i.stallMeta, totals, now: i.now, idleMinutes: i.idleMinutes, watchIdle: watch });
  const desks = desksOf({ card: i.card, cash: i.cash, payouts: i.payouts, people: i.people, terminals: i.terminals });
  const cashCents = sum(i.cash, (r) => r.cents);
  const phoneCents = sum(
    i.card.filter((r) => r.kind === 'phone' || !r.who),
    (r) => r.cents,
  );
  const cardCents = sum(i.card, (r) => r.cents) - phoneCents;
  return {
    scope: i.scope,
    night: i.night,
    from: i.window.from?.toISOString() ?? null,
    to: i.window.to.toISOString(),
    generatedAt: i.now.toISOString(),
    live: i.window.live,
    loaded: {
      totalCents: cashCents + cardCents + phoneCents,
      cashCents,
      cardCents,
      phoneCents,
      count: sum(i.cash, (r) => r.count) + sum(i.card, (r) => r.count),
    },
    sold: {
      totalCents: sum(totalList, (t) => t.cents),
      count: sum(totalList, (t) => t.count),
      refundedCents: sum(totalList, (t) => t.refundedCents),
    },
    lastHour: i.window.live
      ? {
          loadedCents: sum(i.cash, (r) => r.lastHourCents) + sum(i.card, (r) => r.lastHourCents),
          soldCents: sum(totalList, (t) => t.lastHourCents),
        }
      : null,
    inWristbandsCents: i.wristbands.balanceCents,
    activeWristbands: i.wristbands.active,
    hourly: hourlyOf(i.sales, i.window),
    stalls,
    desks,
    alerts: alertsOf({ desks, stalls, cashAlertCents: i.cashAlertCents, now: i.now, watch }),
    idleMinutes: i.idleMinutes,
    cashAlertCents: i.cashAlertCents,
    event: {
      name: i.event.name,
      startsAt: i.event.startsAt?.toISOString() ?? null,
      endsAt: i.event.endsAt?.toISOString() ?? null,
      ended: i.event.ended,
      nights: i.event.nights,
    },
  };
}
