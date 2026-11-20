// OxioParty · En directo (lógica pura de la pantalla): las cifras de arriba,
// las barras de las horas, las casetas con su estado, las taquillas y los
// avisos con su acción. Todo sale de GET /v1/party/live: nada inventado (no
// hay latido de conexión de las casetas: solo «sin cobros desde hace…»).

import type { PartyAlert, PartyDesk, PartyHour, PartyLive, PartyNight, PartyStallLive } from '@nightpay/contracts';
import { formatPercent } from './commission';
import { formatDateTime } from './dates';
import { formatEur } from './money';
import type { Tone } from '../components/Pill';

/** Opciones del aviso «sin cobros desde hace N min» (de serie, 15). */
export const IDLE_OPTIONS: readonly number[] = [10, 15, 20, 30, 45, 60];
export const DEFAULT_IDLE_MINUTES = 15;
/** Recordado en este navegador (una comodidad: sin él, 15). */
export const IDLE_STORAGE_KEY = 'np-party-idle-min';

export function idleFromStorage(raw: string | null | undefined): number {
  const n = Number(raw);
  return IDLE_OPTIONS.includes(n) ? n : DEFAULT_IDLE_MINUTES;
}

// ─── Qué se mira: una noche o la fiesta entera ─────────────────────────

export type LiveSelection = { scope: 'event' } | { scope: 'night'; night?: string };

export interface NightChoice {
  key: string;
  label: string;
  /** «Noche del 23 jun» para el lector de pantalla. */
  title: string;
  selection: LiveSelection;
  pressed: boolean;
}

/**
 * Los botones de arriba: «Noche 1», «Noche 2»… (las de la fiesta) y «Toda la
 * fiesta». Sin fechas de la fiesta, «Esta noche» y «Toda la fiesta».
 */
export function nightChoices(nights: readonly PartyNight[], selected: LiveSelection, timeZone: string): NightChoice[] {
  const isEvent = selected.scope === 'event';
  const selectedNight = selected.scope === 'night' ? selected.night : undefined;
  const list: NightChoice[] =
    nights.length === 0
      ? [{ key: 'now', label: 'Esta noche', title: 'Esta noche', selection: { scope: 'night' }, pressed: !isEvent }]
      : nights.map((n, i) => ({
          key: n.day,
          label: `Noche ${i + 1}`,
          title: `Noche del ${dayLabel(n.day, timeZone)}`,
          selection: { scope: 'night', night: n.day },
          pressed: !isEvent && (selectedNight ? selectedNight === n.day : n.current),
        }));
  // Fuera de las noches de la fiesta (antes o después) y sin elegir ninguna: «Esta noche».
  const anyPressed = list.some((c) => c.pressed);
  const now: NightChoice[] =
    nights.length > 0 && !isEvent && !anyPressed && !selectedNight
      ? [{ key: 'now', label: 'Esta noche', title: 'Esta noche', selection: { scope: 'night' }, pressed: true }]
      : [];
  return [
    ...list,
    ...now,
    { key: 'event', label: 'Toda la fiesta', title: 'Toda la fiesta', selection: { scope: 'event' }, pressed: isEvent },
  ];
}

/** «23 jun» de un día AAAA-MM-DD (a mediodía UTC: el mismo día en cualquier zona). */
export function dayLabel(day: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone }).format(new Date(`${day}T12:00:00Z`)).replace('.', '');
}

/** «En directo · 01:47», «Noche cerrada» o «Fiesta terminada». */
export function liveBadge(live: Pick<PartyLive, 'live' | 'generatedAt' | 'event' | 'scope'>, timeZone: string): { text: string; on: boolean } {
  if (live.live) return { text: `En directo · ${formatDateTime(live.generatedAt, timeZone, 'time')}`, on: true };
  if (live.event.ended) return { text: 'Fiesta terminada', on: false };
  return { text: live.scope === 'event' ? 'Toda la fiesta' : 'Noche cerrada', on: false };
}

// ─── Las cifras de arriba ──────────────────────────────────────────────

export interface Kpi {
  key: 'loaded' | 'sold' | 'left' | 'active';
  label: string;
  value: string;
  hint: string;
  /** La de lo que queda en las pulseras va en oscuro (es de los asistentes). */
  dark: boolean;
}

export function kpisOf(live: PartyLive): Kpi[] {
  const { loaded, sold, lastHour } = live;
  return [
    {
      key: 'loaded',
      label: 'Cargado',
      value: formatEur(loaded.totalCents),
      hint: lastHour
        ? `${signed(lastHour.loadedCents)} en la última hora`
        : `Efectivo ${formatEur(loaded.cashCents)} · tarjeta ${formatEur(loaded.cardCents + loaded.phoneCents)}`,
      dark: false,
    },
    {
      key: 'sold',
      label: 'Vendido',
      value: formatEur(sold.totalCents),
      hint: lastHour
        ? `${signed(lastHour.soldCents)} en la última hora`
        : `${countText(sold.count, 'cobro', 'cobros')}${sold.refundedCents > 0 ? ` · ${formatEur(sold.refundedCents)} devuelto` : ''}`,
      dark: false,
    },
    {
      key: 'left',
      label: 'Aún en las pulseras',
      value: formatEur(live.inWristbandsCents),
      hint: 'Dinero de los asistentes sin gastar: se devuelve si lo piden.',
      dark: true,
    },
    {
      key: 'active',
      label: 'Pulseras activas',
      value: live.activeWristbands.toLocaleString('es-ES'),
      hint: 'Con saldo o que ya han pagado algo.',
      dark: false,
    },
  ];
}

function signed(cents: number): string {
  return cents >= 0 ? `+${formatEur(cents)}` : formatEur(cents);
}

export function countText(n: number, one: string, many: string): string {
  return `${n.toLocaleString('es-ES')} ${n === 1 ? one : many}`;
}

// ─── Ventas por hora ───────────────────────────────────────────────────

export interface HourBar {
  key: string;
  /** «20 h». */
  hour: string;
  /** El día («jue 24») en la primera barra y en la primera de cada día nuevo. */
  day: string | null;
  /** «3,1 k» / «620 €». */
  label: string;
  /** Alto de la barra (0–100 %). */
  pct: number;
  open: boolean;
}

/** «3,1 k» desde 1.000 €; por debajo, «620 €». Lo negativo (solo devoluciones), «0 €». */
export function hourAmountLabel(cents: number): string {
  const euros = Math.max(0, cents) / 100;
  if (euros >= 1000) return `${(euros / 1000).toFixed(1).replace('.', ',')} k`;
  return `${Math.round(euros)} €`;
}

export function hourBars(hours: readonly PartyHour[], timeZone: string): HourBar[] {
  const max = Math.max(0, ...hours.map((h) => h.soldCents));
  let lastDay: string | null = null;
  return hours.map((h) => {
    const at = new Date(h.at);
    const hour = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(at);
    const day = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', timeZone }).format(at).replace('.', '');
    const showDay = day !== lastDay;
    if (showDay) lastDay = day;
    return {
      key: h.at,
      hour: `${hour} h`,
      day: showDay ? day : null,
      label: hourAmountLabel(h.soldCents),
      pct: max > 0 ? Math.round((Math.max(0, h.soldCents) / max) * 100) : 0,
      open: h.open,
    };
  });
}

/** Lo que lee el lector de pantalla de la gráfica. */
export function hoursAria(bars: readonly HourBar[], hours: readonly PartyHour[]): string {
  if (bars.length === 0) return 'Ventas por hora: aún no hay ventas.';
  const parts = bars.map((b, i) => `${b.hour} ${formatEur(hours[i]?.soldCents ?? 0)}`);
  const open = bars.find((b) => b.open);
  return `Ventas por hora: ${parts.join(', ')}${open ? ` (la de las ${open.hour} sigue abierta)` : ''}.`;
}

// ─── Casetas ───────────────────────────────────────────────────────────

export interface StallRowView {
  key: string;
  rank: number;
  name: string;
  meta: string;
  sold: string;
  /** Del total vendido («27 %»). */
  share: string;
  /** Ancho de la barra frente a la que más vendió (0–100). */
  barPct: number;
  /** Parte del organizador: «10 %», «Barra propia» o null (sin caseta). */
  organizer: string | null;
  status: { text: string; tone: Tone } | null;
}

export function stallRows(live: PartyLive, timeZone: string, now: Date): StallRowView[] {
  const top = Math.max(0, ...live.stalls.map((s) => s.soldCents));
  const total = live.sold.totalCents;
  return live.stalls.map((s, i) => ({
    key: s.id ?? 'none',
    rank: i + 1,
    name: s.name,
    meta: `${countText(s.count, 'cobro', 'cobros')}${s.lastAt ? ` · último ${formatDateTime(s.lastAt, timeZone, 'time')}` : ''}`,
    sold: formatEur(s.soldCents),
    share: total > 0 ? `${Math.round((Math.max(0, s.soldCents) / total) * 100)} %` : '0 %',
    barPct: top > 0 ? Math.round((Math.max(0, s.soldCents) / top) * 100) : 0,
    organizer: s.id === null ? null : s.ownBar ? 'Barra propia' : formatPercent(s.organizerBps ?? 0),
    status: stallStatus(s, live, now),
  }));
}

/** El estado de una caseta (solo en la noche en curso): parada, cobrando, sin cobros aún o desactivada. */
export function stallStatus(s: PartyStallLive, live: Pick<PartyLive, 'live' | 'scope'>, now: Date): { text: string; tone: Tone } | null {
  if (!live.live || live.scope !== 'night' || s.id === null) return null;
  if (!s.active) return { text: 'Desactivada', tone: 'neutral' };
  if (s.idle && s.lastAt) return { text: `Sin cobros · ${minutesSince(s.lastAt, now)} min`, tone: 'danger' };
  if (!s.lastAt) return { text: 'Sin cobros aún', tone: 'neutral' };
  return { text: 'Cobrando', tone: 'success' };
}

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
}

// ─── De dónde entra el dinero ──────────────────────────────────────────

export interface DeskView {
  key: string;
  name: string;
  detail: string;
  total: string;
  /** Pasa del umbral de efectivo (se marca). */
  over: boolean;
}

export function deskRows(live: Pick<PartyLive, 'desks' | 'cashAlertCents'>): DeskView[] {
  return live.desks.map((d: PartyDesk) => {
    if (d.kind === 'phone') {
      return { key: d.key, name: d.name, detail: 'Recargas de los asistentes', total: formatEur(d.cardCents), over: false };
    }
    const inDesk = d.cashInDeskCents !== d.cashCents ? ` · en la caja ${formatEur(d.cashInDeskCents)}` : '';
    return {
      key: d.key,
      name: d.name,
      detail: `Efectivo ${formatEur(d.cashCents)} · tarjeta ${formatEur(d.cardCents)}${inDesk}`,
      total: formatEur(d.cashCents + d.cardCents),
      over: live.cashAlertCents > 0 && d.cashInDeskCents > live.cashAlertCents,
    };
  });
}

// ─── Avisos ────────────────────────────────────────────────────────────

export type AlertAction =
  | { kind: 'call'; label: string; href: string }
  | { kind: 'desks'; label: string }
  | { kind: 'stalls'; label: string };

export interface AlertView {
  key: string;
  tone: 'danger' | 'warning';
  icon: 'cash' | 'idle';
  title: string;
  text: string;
  action: AlertAction;
}

/** Un teléfono que se puede marcar («600 000 000», «+34 600…»): tel:+34600000000. */
export function telHref(contact: string | null | undefined): string | null {
  const value = contact?.trim() ?? '';
  if (!/^\+?[\d\s().-]{6,20}$/.test(value)) return null;
  const digits = value.replace(/[^\d+]/g, '');
  return digits.replace(/\+/g, '').length >= 6 ? `tel:${digits}` : null;
}

export function alertViews(alerts: readonly PartyAlert[], timeZone: string, now: Date): AlertView[] {
  return alerts.map((a) => {
    if (a.kind === 'CASH_OVER') {
      return {
        key: `cash:${a.deskKey}`,
        tone: 'warning',
        icon: 'cash',
        title: `${a.name}: ${formatEur(a.cashCents)} en efectivo`,
        text: `Pasa de ${formatEur(a.thresholdCents)}. Conviene retirar parte del efectivo.`,
        action: { kind: 'desks', label: 'Ver las taquillas' },
      };
    }
    const tel = telHref(a.managerContact);
    const last = formatDateTime(new Date(now.getTime() - a.minutes * 60_000), timeZone, 'time');
    return {
      key: `idle:${a.stallId}`,
      tone: 'danger',
      icon: 'idle',
      title: `${a.name}: sin cobros desde hace ${a.minutes} min`,
      text: `Su último cobro fue a las ${last} y las demás casetas siguen cobrando.${a.managerContact && !tel ? ` Contacto: ${a.managerContact}.` : ''}`,
      action: tel ? { kind: 'call', label: `Llamar a ${a.managerName}`, href: tel } : { kind: 'stalls', label: 'Ver la caseta' },
    };
  });
}

/** «23 y 24 de junio · 6 casetas · 2 taquillas» (lo que se sabe). */
export function eventSubtitle(live: PartyLive, timeZone: string): string {
  const parts: string[] = [];
  if (live.event.startsAt) {
    const from = formatDateTime(live.event.startsAt, timeZone, 'short');
    parts.push(live.event.endsAt ? `Del ${from} al ${formatDateTime(live.event.endsAt, timeZone, 'short')}` : `Desde el ${from}`);
  }
  const stalls = live.stalls.filter((s) => s.id !== null && s.active).length;
  parts.push(countText(stalls, 'caseta', 'casetas'));
  const desks = live.desks.filter((d) => d.kind !== 'phone').length;
  if (desks > 0) parts.push(countText(desks, 'taquilla', 'taquillas'));
  return parts.join(' · ');
}
