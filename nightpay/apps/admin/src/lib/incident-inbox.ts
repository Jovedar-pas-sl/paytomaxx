// Bandeja de incidencias: grupo y título por tipo, dónde se arregla cada una
// y el registro de «Resueltas hoy». El API solo devuelve las abiertas, así que
// lo resuelto se apunta en este dispositivo (lo que se marcó aquí y lo que
// desapareció de la lista mientras se miraba).

import type { Incident, IncidentKind } from './api';
import type { PanelTab, TabKey } from './roles';

interface KindMeta {
  /** Etiqueta corta encima del título (se lee sin depender del color). */
  group: string;
  /** Título si el API no manda uno. */
  title: string;
  /** Pestaña donde se arregla (null: fuera del panel). */
  tab: TabKey | null;
  /** Se arregla en el propio cobro (Hoy → Cobros → Devoluciones → Resolver): «Abrir cobro». */
  opensPayment?: boolean;
  /** Cómo se arregla, en una línea (debajo de los botones). */
  hint?: string;
}

export const INCIDENT_KINDS: Record<IncidentKind, KindMeta> = {
  stuck_payment: { group: 'Cobro', title: 'Cobro atascado esperando al banco', tab: 'payments' },
  duplicate_charge: { group: 'Cobro', title: 'El cliente pagó dos veces', tab: 'payments' },
  amount_mismatch: { group: 'Cobro', title: 'El banco aprobó un importe distinto', tab: 'payments' },
  approval_unverified: { group: 'Cobro', title: 'Aviso de pago sin comprobar', tab: 'payments' },
  approval_unbooked: { group: 'Cobro', title: 'Cobro del banco sin apuntar', tab: 'payments' },
  refund_pending: {
    group: 'Devolución',
    title: 'Devolución sin confirmar por el banco',
    tab: 'payments',
    opensPayment: true,
  },
  earning_reverse_failed: { group: 'Compañeras', title: 'Devolución sin descontar a la compañera', tab: 'operators' },
  night_closed_pending: { group: 'Noche', title: 'Noche cerrada con cobros sin resolver', tab: 'nights' },
  pos_charge_mismatch: { group: 'Datáfono', title: 'Venta del datáfono que no cuadra', tab: 'terminals' },
  pos_unmatched_op: { group: 'Datáfono', title: 'Venta del datáfono sin cobro', tab: 'terminals' },
  pos_unreconciled: { group: 'Datáfono', title: 'Cobro del datáfono sin cuadrar', tab: 'terminals' },
  pos_voided_paid: { group: 'Datáfono', title: 'Venta anulada y el cobro sigue pagado', tab: 'payments' },
  pos_unproven_sales: {
    group: 'Datáfono',
    title: 'Ventas del datáfono sin comprobar',
    // En Hoy → Cobros no se resuelven (salen como pagadas, sin «Resolver»): se cuadran con el banco.
    tab: 'bank',
    hint: 'Se cuadran en Informes → Banco: sube el fichero del banco y las que coincidan dejan de retener la comisión. Sin el fichero, se liberan con tu 2FA en la ficha de quien cobra esa comisión.',
  },
  pos_reception_limit: {
    group: 'Datáfono',
    title: 'Tope de recepción superado',
    tab: 'terminals',
    hint: 'Si no es el datáfono de la recepción o no lo reconoces, desvincúlalo en Datáfonos.',
  },
  wallet_credit_skipped: { group: 'Saldo', title: 'Recarga cobrada sin saldo', tab: 'wallets' },
  wallet_close_requested: { group: 'Saldo', title: 'Un cliente pide su saldo', tab: 'wallets' },
  wallet_open_balance: { group: 'Saldo', title: 'Saldo de un cliente sin devolver', tab: 'wallets' },
  wallet_topup_unassigned: {
    group: 'Saldo',
    title: 'Recarga pendiente de asignar',
    tab: 'wallets',
    hint: 'Asígnala con el código del cliente en Saldos, o con su NFC en Recepción.',
  },
  wallet_card_lost: {
    group: 'Saldo',
    title: 'Un cliente ha bloqueado su NFC',
    tab: 'wallets',
    hint: 'Su saldo sigue valiendo con su código. Si viene a recepción, dale un NFC nuevo.',
  },
  sensitive_action: {
    group: 'Saldo',
    title: 'Acción delicada',
    tab: 'wallets',
    hint: 'Comprueba que es lo que tenía que pasar. Si no, cambia las contraseñas y corta esa sesión.',
  },
  cash_split_suspected: {
    group: 'Efectivo',
    title: 'Efectivo troceado en saldos nuevos',
    tab: 'wallets',
    hint: 'Revisa las recargas en efectivo en Saldos: juntas pueden ser una sola entrega de más de 1.000 €.',
  },
  reception_payout_cap: {
    group: 'Efectivo',
    title: 'Recepción pasa su tope de la noche',
    tab: 'wallets',
    hint: 'Desde ahí, cada salida en efectivo de esa persona la confirma el encargado con su 2FA. Revisa sus salidas en Saldos.',
  },
  bank_mismatch: { group: 'Banco', title: 'Diferencia con el banco', tab: 'bank' },
  backup_stale: { group: 'Copias', title: 'Sin copia de seguridad reciente', tab: null },
  backup_unmonitored: { group: 'Copias', title: 'Las copias de seguridad no se vigilan', tab: null },
  // Se decide en la misma bandeja (Avisos): la tarjeta de «Por aprobar».
  approval_pending: { group: 'Por aprobar', title: 'Solicitud del encargado sin decidir', tab: null },
};

const UNKNOWN_KIND: KindMeta = { group: 'Aviso', title: 'Incidencia', tab: null };

/** Un tipo nuevo del API que esta versión no conoce no rompe la bandeja. */
export function kindMeta(kind: string): KindMeta {
  return INCIDENT_KINDS[kind as IncidentKind] ?? UNKNOWN_KIND;
}

/**
 * La línea de ayuda de la incidencia: la de su tipo; si no tiene, en las que
 * se quitan solas, cómo se quitan. null: ninguna.
 */
export function incidentHint(kind: string, ackable: boolean): string | null {
  const meta = kindMeta(kind);
  if (meta.hint) return meta.hint;
  if (ackable) return null;
  return meta.opensPayment ? 'En el cobro: Devoluciones → Resolver. Se quita sola al resolverla.' : 'Se quita sola cuando se arregla.';
}

export function incidentKey(i: { kind: string; refId: string }): string {
  return `${i.kind}:${i.refId}`;
}

/** El título del API (concreto) y, si viene vacío, el del tipo. */
export function incidentHeading(i: Pick<Incident, 'kind' | 'title'>): string {
  return i.title.trim() || kindMeta(i.kind).title;
}

/** Pestaña donde se arregla, solo si ese rol la ve. */
export function fixTabFor(kind: string, tabs: readonly PanelTab[]): TabKey | null {
  const tab = kindMeta(kind).tab;
  return tab && tabs.some((t) => t.key === tab) ? tab : null;
}

/** Abiertas antes que ya no vienen: se resolvieron (aquí, en otro sitio o solas). */
export function vanished(previous: readonly Incident[], next: readonly Incident[]): Incident[] {
  const still = new Set(next.map(incidentKey));
  return previous.filter((i) => !still.has(incidentKey(i)));
}

export interface ResolvedIncident {
  key: string;
  kind: string;
  title: string;
  /** ISO */
  resolvedAt: string;
  /** 'ack' = marcada aquí; 'gone' = desapareció de la lista. */
  how: 'ack' | 'gone';
  note?: string;
}

/** Lo resuelto en un día del local ("AAAA-MM-DD"). */
export interface ResolvedLog {
  day: string;
  items: ResolvedIncident[];
}

const MAX_RESOLVED = 50;

export function resolvedToday(log: ResolvedLog | null, day: string): ResolvedIncident[] {
  return log && log.day === day ? log.items : [];
}

/** Registro nuevo con lo recién resuelto delante; un día nuevo empieza de cero. */
export function recordResolved(
  log: ResolvedLog | null,
  day: string,
  fresh: readonly ResolvedIncident[],
): ResolvedLog {
  const byKey = new Map<string, ResolvedIncident>();
  for (const item of [...resolvedToday(log, day), ...fresh]) {
    const known = byKey.get(item.key);
    if (!known || item.resolvedAt >= known.resolvedAt) byKey.set(item.key, item);
  }
  const items = [...byKey.values()]
    .sort((a, b) => (a.resolvedAt < b.resolvedAt ? 1 : a.resolvedAt > b.resolvedAt ? -1 : 0))
    .slice(0, MAX_RESOLVED);
  return { day, items };
}
