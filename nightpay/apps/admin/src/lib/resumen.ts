// La portada «Resumen» (idea 13), en cuentas puras: las filas de «Pide tu
// atención» y la línea de las horas bajo «Pagado esta noche». Solo eligen y
// escriben lo que ya llega del API (aprobaciones, avisos y la noche abierta):
// ninguna cifra se calcula distinta de como la da el API.

import type { ApprovalView } from '@nightpay/contracts';
import { formatRelative } from '@nightpay/ui';
import type { Incident } from './api';
import { kindLabel, sortApprovals } from './approvals';
import { inboxHiddenKinds } from './bottom-nav';
import { formatDateTime } from './dates';
import { fixTabFor, incidentHeading, incidentKey, kindMeta } from './incident-inbox';
import { formatEur } from './money';
import type { PanelTab, TabKey } from './roles';
import { peakIndex } from './sparkline';

/** Filas que caben en «Pide tu atención». */
export const ATTENTION_MAX = 3;

export type AttentionAction =
  | { kind: 'avisos'; label: string }
  | { kind: 'payment'; label: string; paymentId: string }
  | { kind: 'tab'; label: string; tab: TabKey };

export interface AttentionItem {
  key: string;
  tone: 'info' | 'warning';
  /** La etiqueta de delante («Por aprobar», «Cobro», «Personal»…). */
  tag: string;
  title: string;
  /** La línea de debajo: «{importe} · hace 12 min» (sin importe, solo cuándo). */
  meta: string;
  action: AttentionAction;
}

export interface AttentionInput {
  /** Las del local (useApprovals); null mientras llegan. */
  approvals: readonly ApprovalView[] | null;
  /** Las abiertas (useIncidents); null mientras llegan. */
  incidents: readonly Incident[] | null;
  isOwner: boolean;
  /** Las pestañas que ve este rol (para «Ir a {pestaña}»). */
  tabs: readonly PanelTab[];
  now: Date;
  timeZone: string;
}

/**
 * Lo que pide atención, como mucho ATTENTION_MAX filas: primero lo que quien
 * mira puede decidir («Por aprobar», en el orden de Avisos: la más antigua
 * arriba) y luego los avisos abiertos, lo nuevo arriba, sin los que en Avisos
 * no salen (inboxHiddenKinds). `total`: todo lo que hay (para «Ver los N avisos»).
 */
export function attentionList(input: AttentionInput): { items: AttentionItem[]; total: number } {
  const decide = sortApprovals(input.approvals ?? []).filter((a) => a.status === 'PENDING' && a.canDecide);
  const hidden = inboxHiddenKinds(input.isOwner);
  const incidents = (input.incidents ?? [])
    .filter((i) => !hidden.has(i.kind))
    .slice()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const when = (at: string) => formatRelative(at, input.now, input.timeZone);
  const all: AttentionItem[] = [
    ...decide.map((a) => ({
      key: `approval:${a.id}`,
      tone: 'info' as const,
      tag: 'Por aprobar',
      title: `${kindLabel(a)} · ${formatEur(a.amountCents)}`,
      // El importe ya va en el título.
      meta: when(a.requestedAt),
      action: { kind: 'avisos' as const, label: 'Decidir' },
    })),
    ...incidents.map((i) => ({
      key: `incident:${incidentKey(i)}`,
      tone: 'warning' as const,
      tag: kindMeta(i.kind).group,
      title: incidentHeading(i),
      meta: i.amountCents === null ? when(i.occurredAt) : `${formatEur(i.amountCents)} · ${when(i.occurredAt)}`,
      action: incidentAction(i, input.tabs),
    })),
  ];
  return { items: all.slice(0, ATTENTION_MAX), total: all.length };
}

/** «Abrir cobro» si se arregla en el propio cobro; si no, «Ir a {pestaña}» (si este rol la ve); si no, «Ver aviso». */
function incidentAction(i: Incident, tabs: readonly PanelTab[]): AttentionAction {
  if (kindMeta(i.kind).opensPayment && i.paymentId) return { kind: 'payment', label: 'Abrir cobro', paymentId: i.paymentId };
  const tab = fixTabFor(i.kind, tabs);
  const label = tab ? tabs.find((t) => t.key === tab)?.label : undefined;
  if (tab && label) return { kind: 'tab', label: `Ir a ${label}`, tab };
  return { kind: 'avisos', label: 'Ver aviso' };
}

/** «Ver los 5 avisos» si hay más de los que caben; null si caben todos. */
export function moreAvisosLabel(total: number): string | null {
  return total > ATTENTION_MAX ? `Ver los ${total} avisos` : null;
}

export interface NightHourView {
  at: string;
  chargedCents: number;
  open: boolean;
}

/** La hora del local de un instante (0-23). */
function localHour(at: string, timeZone: string): number {
  return Number(formatDateTime(at, timeZone, 'time').slice(0, 2));
}

/**
 * La línea bajo «Pagado»: «{N} pagos · el pico, a las {h} h · de media», y la
 * media aparte (se escribe con Importe). N es lo que suma «Pagado esta
 * noche»: los cobros más las recargas en efectivo; la media, lo pagado entre
 * N. En la franja entera (`full`), desde «el pico». Sin pagos, null.
 */
export function hoursLine(input: {
  count: number;
  cashTopUpsCount?: number;
  chargedCents: number;
  hourly: readonly NightHourView[] | undefined;
  timeZone: string;
  full?: boolean;
}): { lead: string; averageCents: number } | null {
  const n = input.count + (input.cashTopUpsCount ?? 0);
  if (n <= 0) return null;
  const hours = input.hourly ?? [];
  const peak = peakIndex(hours.map((h) => h.chargedCents));
  const parts = [
    input.full ? null : `${n} ${n === 1 ? 'pago' : 'pagos'}`,
    peak === null ? null : `el pico, a las ${localHour(hours[peak]!.at, input.timeZone)} h`,
    'de media',
  ].filter((p): p is string => p !== null);
  return { lead: parts.join(' · '), averageCents: Math.round(input.chargedCents / n) };
}

/** Lo que lee el lector de pantalla del gráfico: «Por hora, de 22 h a 3 h» (hora del local). */
export function hourlyLabel(hourly: readonly NightHourView[], timeZone: string): string {
  if (hourly.length === 0) return 'Por hora';
  return `Por hora, de ${localHour(hourly[0]!.at, timeZone)} h a ${localHour(hourly[hourly.length - 1]!.at, timeZone)} h`;
}
