import {
  RESERVATION_STATUS_TEXT,
  reservationDepositCents,
  type ReservationGuestView,
  type ReservationKind,
  type ReservationPackageView,
  type ReservationSource,
  type ReservationStatus,
  type ReservationView,
} from '@nightpay/contracts';
import { dayOf, itemsLeft, itemsOf, type ItemLine } from './reservation-rules';

/** Un paquete tal como lo guarda la base. */
export interface PackageRow {
  id: string;
  name: string;
  kind: string;
  priceCents: number;
  creditCents: number;
  entries: number;
  items: unknown;
  description: string | null;
  maxPerNight: number | null;
  active: boolean;
}

export function packageView(p: PackageRow): ReservationPackageView {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind as ReservationKind,
    priceCents: p.priceCents,
    creditCents: p.creditCents,
    depositCents: reservationDepositCents(p.priceCents),
    entries: p.entries,
    items: itemsOf(p.items),
    description: p.description,
    maxPerNight: p.maxPerNight,
    active: p.active,
  };
}

/** Lo que se lee de una reserva para enseñarla (panel, puerta, página del grupo). */
export const RESERVATION_VIEW_INCLUDE = {
  guests: { orderBy: { seq: 'asc' as const } },
  spends: { orderBy: { createdAt: 'asc' as const } },
  wallet: { select: { balanceCents: true, status: true, qrToken: true } },
  promoter: { select: { user: { select: { displayName: true, email: true } } } },
  // Lo pagado con bitcoin (si hay que devolverlo: solo en euros, nunca por la pasarela ni en bitcoin).
  payments: { where: { paidAt: { not: null }, payment: { provider: 'BTCPAY' as const } }, select: { amountCents: true } },
};

export interface ReservationRow {
  id: string;
  ref: string;
  status: string;
  nightDate: Date;
  previousNightDate: Date | null;
  dateChangedAt: Date | null;
  packageName: string;
  kind: string;
  priceCents: number;
  creditCents: number;
  depositCents: number;
  paidCents: number;
  entries: number;
  items: unknown;
  customerName: string;
  customerPhone: string | null;
  notes: string | null;
  tableLabel: string | null;
  source: string;
  soldByUserId: string | null;
  arrivedAt: Date | null;
  noShowAuto: boolean;
  canceledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  guests: Array<{ id: string; seq: number; label: string | null; checkedInAt: Date | null }>;
  spends: Array<{ guestId: string; kind: string; itemName: string | null; qty: number | null; amountCents: number }>;
  wallet: { balanceCents: number; status: string; qrToken: string } | null;
  promoter: { user: { displayName: string | null; email: string } } | null;
  /** Los pagos de la reserva hechos con bitcoin (RESERVATION_VIEW_INCLUDE). */
  payments?: Array<{ amountCents: number }>;
}

/** Lo servido de cada cosa (paquetes de cosas fijas). */
export function servedItems(spends: ReservationRow['spends']): ItemLine[] {
  return spends.flatMap((s) => (s.kind === 'ITEM' && s.itemName ? [{ name: s.itemName, qty: s.qty ?? 0 }] : []));
}

function guestView(g: ReservationRow['guests'][number], spends: ReservationRow['spends']): ReservationGuestView {
  const mine = spends.filter((s) => s.guestId === g.id);
  return {
    id: g.id,
    seq: g.seq,
    label: g.label,
    checkedIn: g.checkedInAt !== null,
    spentCents: mine.reduce((a, s) => a + s.amountCents, 0),
    items: servedItems(mine),
  };
}

/** «Vendido por»: la web, el RRPP (su nombre) o el panel (quién). */
export function soldByText(r: Pick<ReservationRow, 'source' | 'promoter'>, panelUser: string | null): string {
  if (r.source === 'RRPP') return `RRPP: ${r.promoter?.user.displayName ?? r.promoter?.user.email ?? '—'}`;
  if (r.source === 'PANEL') return panelUser ? `Panel: ${panelUser}` : 'Panel';
  return 'Web';
}

export function reservationView(r: ReservationRow, panelUser: string | null = null): ReservationView {
  const status = r.status as ReservationStatus;
  const items = itemsOf(r.items);
  return {
    id: r.id,
    ref: r.ref,
    status,
    statusText: status === 'CANCELED' && r.paidCents > 0 ? 'Anulada por el local' : RESERVATION_STATUS_TEXT[status],
    nightDate: dayOf(r.nightDate),
    previousNightDate: r.previousNightDate ? dayOf(r.previousNightDate) : null,
    dateChanged: r.dateChangedAt !== null,
    packageName: r.packageName,
    kind: r.kind as ReservationKind,
    priceCents: r.priceCents,
    creditCents: r.creditCents,
    depositCents: r.depositCents,
    paidCents: r.paidCents,
    paidWithBitcoinCents: (r.payments ?? []).reduce((sum, p) => sum + p.amountCents, 0),
    pendingCents: Math.max(0, r.priceCents - r.paidCents),
    entries: r.entries,
    items,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    notes: r.notes,
    tableLabel: r.tableLabel,
    source: r.source as ReservationSource,
    soldBy: soldByText(r, panelUser),
    promoterName: r.promoter ? (r.promoter.user.displayName ?? r.promoter.user.email) : null,
    balanceCents: r.wallet ? r.wallet.balanceCents : null,
    itemsLeft: itemsLeft(items, servedItems(r.spends)),
    guests: r.guests.map((g) => guestView(g, r.spends)),
    arrivedAt: r.arrivedAt?.toISOString() ?? null,
    noShowAuto: r.noShowAuto,
    canceledAt: r.canceledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt.toISOString(),
  };
}
