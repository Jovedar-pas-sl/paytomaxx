/**
 * Bandeja de incidencias (Fase 1E): lo que el dueño tiene que mirar. Se
 * calcula al vuelo desde cobros, avisos y registros; las que no se resuelven
 * solas (un doble cobro, un descuento que falló…) se marcan como revisadas.
 */

export type IncidentKind =
  | 'stuck_payment'
  | 'duplicate_charge'
  | 'earning_reverse_failed'
  | 'wallet_credit_skipped'
  | 'night_closed_pending';

/** Las que desaparecen solas al resolverse (no se marcan como revisadas). */
export const SELF_RESOLVING: ReadonlySet<IncidentKind> = new Set<IncidentKind>(['stuck_payment']);

export interface Incident {
  kind: IncidentKind;
  /** Id de lo que la provoca (cobro, aviso, registro o noche). */
  refId: string;
  title: string;
  detail: string;
  occurredAt: string;
  amountCents: number | null;
  paymentId: string | null;
  /** true = se quita marcándola como revisada; false = se quita resolviéndola. */
  ackable: boolean;
}

/** Filas crudas que lee el servicio, una por tipo. */
export interface StuckRow {
  id: string;
  status: string;
  amountCents: number;
  updatedAt: Date;
}
export interface EventRow {
  id: string;
  paymentId: string | null;
  amountCents: number | null;
  occurredAt: Date;
  payload: unknown;
}
export interface NightPendingRow {
  id: string;
  closedAt: Date;
  pendingAtClose: number;
  autoClosed: boolean;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function str(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

export function stuckIncident(r: StuckRow): Incident {
  const orphan = r.status === 'ORPHAN';
  return {
    kind: 'stuck_payment',
    refId: r.id,
    title: orphan ? 'Cobro sin confirmar por el banco' : 'Cobro atascado esperando al banco',
    detail: `${eur(r.amountCents)}. Búscalo en el portal de BBVA y resuélvelo en Pagos → Resolver.`,
    occurredAt: r.updatedAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.id,
    ackable: false,
  };
}

export function duplicateChargeIncident(r: EventRow): Incident {
  const order = str(r.payload, 'order');
  return {
    kind: 'duplicate_charge',
    refId: r.id,
    title: 'El cliente pagó dos veces',
    detail: `Devuelve uno en el portal de BBVA${order ? ` (pedido ${order})` : ''} y regístralo en Pagos → Devolución BBVA.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

export function earningReverseFailedIncident(r: EventRow): Incident {
  return {
    kind: 'earning_reverse_failed',
    refId: r.id,
    title: 'No se pudo descontar una devolución a la chica',
    detail: 'Revisa su saldo en Operadoras: la devolución está hecha pero su comisión no se ha descontado.',
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

export function walletCreditSkippedIncident(r: EventRow): Incident {
  return {
    kind: 'wallet_credit_skipped',
    refId: r.id,
    title: 'Recarga cobrada sin saldo en la wallet',
    detail: 'El cliente pagó pero la wallet no estaba activa. Devuélvelo en BBVA o reactiva la wallet.',
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

export function nightClosedPendingIncident(r: NightPendingRow): Incident {
  return {
    kind: 'night_closed_pending',
    refId: r.id,
    title: r.autoClosed
      ? 'La noche se cerró sola con cobros sin resolver'
      : 'La noche se cerró con cobros sin resolver',
    detail: `${r.pendingAtClose === 1 ? '1 cobro quedó pendiente' : `${r.pendingAtClose} cobros quedaron pendientes`}. Resuélvelos en Pagos.`,
    occurredAt: r.closedAt.toISOString(),
    amountCents: null,
    paymentId: null,
    ackable: true,
  };
}

/** Más recientes primero; quita las ya revisadas. */
export function openIncidents(all: ReadonlyArray<Incident>, acked: ReadonlySet<string>): Incident[] {
  return all
    .filter((i) => !i.ackable || !acked.has(ackKey(i.kind, i.refId)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function ackKey(kind: string, refId: string): string {
  return `${kind}:${refId}`;
}
