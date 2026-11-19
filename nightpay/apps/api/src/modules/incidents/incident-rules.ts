/**
 * Bandeja de incidencias (Fase 1E): lo que el dueño tiene que mirar. Se
 * calcula al vuelo desde cobros, avisos y registros; las que no se resuelven
 * solas (un doble cobro, un descuento que falló…) se marcan como revisadas.
 */

import { STAFF_WATCH_SAME_SALDO_MINUTES, formatChargeRef } from '@nightpay/contracts';
import { BRAND_NAME } from '../../common/brand';
import { madridDay } from '../../common/time/madrid';
import type { BackupVerdict } from '../db-backups/backup-check';
import { SALDOS_TAB_PATH } from '../wallets/saldo-texts';
import { formatWalletCode } from '../wallets/wallet-rules';
import { PAID_AFTER_CANCEL_REASON } from '../payments/paid-after-cancel';
import { bitcoinAnomalyIncident } from './bitcoin-incidents';

export type IncidentKind =
  | 'stuck_payment'
  | 'duplicate_charge'
  | 'earning_reverse_failed'
  | 'wallet_credit_skipped'
  | 'night_closed_pending'
  | 'pos_charge_mismatch'
  | 'pos_unmatched_op'
  | 'pos_unreconciled'
  | 'pos_voided_paid'
  | 'wallet_close_requested'
  // Ya no sale: el saldo que queda tras la noche es para la próxima visita (17-nov-2026).
  | 'wallet_open_balance'
  | 'bank_mismatch'
  | 'backup_stale'
  | 'backup_unmonitored'
  | 'approval_unverified'
  | 'amount_mismatch'
  | 'approval_unbooked'
  | 'refund_pending'
  | 'approval_pending'
  | 'pos_unproven_sales'
  | 'pos_reception_limit'
  | 'cash_split_suspected'
  | 'reception_payout_cap'
  | 'wallet_topup_unassigned'
  | 'wallet_card_lost'
  | 'wallet_charge_disputed'
  | 'sensitive_action'
  | 'bitcoin_overpaid'
  // Avisos por persona (19-11-2026): cancelaciones, «Otro importe», PIN y cobros seguidos al mismo saldo.
  | 'staff_pattern';

/** Las que desaparecen solas al resolverse (no se marcan como revisadas). */
export const SELF_RESOLVING: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'stuck_payment',
  'pos_unreconciled',
  'wallet_close_requested',
  'wallet_open_balance',
  'backup_stale',
  'approval_unverified',
  'refund_pending',
  'approval_pending',
  'wallet_topup_unassigned',
]);

/**
 * Las que se quitan marcándolas como revisadas (las demás, al resolverlas).
 * El endpoint de "revisada" acepta exactamente estas.
 */
export const ACKABLE_KINDS = [
  'duplicate_charge',
  'earning_reverse_failed',
  'wallet_credit_skipped',
  'night_closed_pending',
  'pos_charge_mismatch',
  'pos_unmatched_op',
  'pos_voided_paid',
  'bank_mismatch',
  'backup_unmonitored',
  'amount_mismatch',
  'approval_unbooked',
  'pos_unproven_sales',
  'pos_reception_limit',
  'cash_split_suspected',
  'reception_payout_cap',
  'wallet_card_lost',
  'wallet_charge_disputed',
  'sensitive_action',
  'bitcoin_overpaid',
  'staff_pattern',
] as const satisfies readonly IncidentKind[];

/**
 * Avisos de dinero (B11): cobros, devoluciones, datáfono, efectivo y banco.
 * Para cerrarlos hay que escribir qué se hizo (queda en el registro).
 */
const MONEY_ACK_KINDS: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'duplicate_charge',
  'amount_mismatch',
  'approval_unbooked',
  'earning_reverse_failed',
  'wallet_credit_skipped',
  'night_closed_pending',
  'pos_charge_mismatch',
  'pos_unmatched_op',
  'pos_voided_paid',
  'pos_unproven_sales',
  'pos_reception_limit',
  'cash_split_suspected',
  'reception_payout_cap',
  'bank_mismatch',
  // «No he sido yo»: se cierra diciendo qué se hizo (devuelto, era suyo…).
  'wallet_charge_disputed',
  'bitcoin_overpaid',
  // Avisos por persona: se cierran diciendo qué se hizo (hablado con esa persona…).
  'staff_pattern',
]);

/** Letras mínimas de la nota de un aviso de dinero (como la del cierre con cobros sin terminar). */
export const MIN_ACK_NOTE_LENGTH = 3;

/**
 * ¿Pide nota para cerrarlo? Los de dinero y las acciones delicadas con
 * importe (un cobro sin Face ID, uno dado por pagado a mano…).
 */
export function ackNeedsNote(i: Pick<Incident, 'kind' | 'amountCents'>): boolean {
  if (MONEY_ACK_KINDS.has(i.kind)) return true;
  return i.kind === 'sensitive_action' && (i.amountCents ?? 0) > 0;
}

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
  /** Se cierra escribiendo qué se hizo (aviso de dinero, B11). Lo pone la bandeja (list). */
  noteRequired?: boolean;
  /**
   * El detalle sin el nombre de la chica, para Telegram (un tercero) cuando
   * el local no quiere nombres (Ajustes → Avisos). Sin él, el detalle no lleva nombres.
   */
  alertDetail?: string;
  /**
   * Bitcoin sin cobro que se puede devolver en efectivo (si el local lo tiene
   * encendido): la factura de BTCPay y lo máximo, lo que llegó en € de la factura.
   */
  cashReturn?: { invoiceId: string; maxCents: number };
  /**
   * «Pagó después de cancelar» con el cobro aún cancelado: el encargado o el
   * dueño, con su 2FA, lo puede dar por bueno (pasa a pagado con su nota).
   */
  acceptable?: boolean;
}

/** Filas crudas que lee el servicio, una por tipo. */
export interface StuckRow {
  id: string;
  status: string;
  amountCents: number;
  updatedAt: Date;
  /** BTCPAY: paga con bitcoin (no hay banco: se mira su factura en BTCPay). Sin el campo, el banco. */
  provider?: string | null;
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
  const bitcoin = r.provider === 'BTCPAY';
  return {
    kind: 'stuck_payment',
    refId: r.id,
    title: bitcoin ? 'Cobro con bitcoin sin terminar' : orphan ? 'Cobro sin confirmar por el banco' : 'Cobro atascado esperando al banco',
    // Con bitcoin no hay banco: su factura en BTCPay dice si se pagó (y su id es lo que pide «Resolver»).
    detail: bitcoin
      ? `${eur(r.amountCents)}. Mira su factura en tu BTCPay (Facturas, por importe y hora) y resuélvelo en Hoy → Cobros → Resolver con el id de la factura.`
      : `${eur(r.amountCents)}. Búscalo en el portal de BBVA y resuélvelo en Hoy → Cobros → Resolver.`,
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
    detail: `Devuelve uno en el portal de BBVA${order ? ` (pedido ${order})` : ''} y regístralo en Hoy → Cobros → Devolución BBVA.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

export function earningReverseFailedIncident(r: EventRow): Incident {
  const p = (r.payload ?? {}) as { error?: unknown; attempts?: unknown };
  // El repaso lo avisa cuando ya no lo arregla solo: tras cuántos intentos y por qué.
  const tries = typeof p.attempts === 'number' ? ` El repaso automático lo ha intentado ${p.attempts} veces.` : '';
  const why = typeof p.error === 'string' && p.error.trim() ? ` Motivo: ${p.error.trim().slice(0, 200)}` : '';
  return {
    kind: 'earning_reverse_failed',
    refId: r.id,
    title: 'No se pudo descontar una devolución a la chica',
    detail: `Revisa su saldo en Operadoras: la devolución está hecha pero su comisión no se ha descontado.${tries}${why}`,
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
    title: 'Recarga cobrada que no llegó al saldo',
    detail: 'El cliente pagó pero su saldo no estaba activo. Devuélvelo en BBVA o reactiva el saldo.',
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

/** Saldos nuevos en efectivo seguidos de la misma persona o datáfono que pasan de 1.000 € (CashTopUpService). */
export function cashSplitIncident(r: EventRow): Incident {
  const raw = r.payload && typeof r.payload === 'object' ? (r.payload as { count?: unknown }).count : null;
  const count = typeof raw === 'number' ? raw : null;
  return {
    kind: 'cash_split_suspected',
    refId: r.id,
    title: 'Efectivo troceado en saldos nuevos',
    detail: `${count ? `${count} saldos nuevos` : 'Varios saldos nuevos'} en efectivo seguidos de la misma persona o datáfono pasan de 1.000 € (cada saldo tiene su tope; juntos podrían ser una sola entrega). Revisa las recargas en efectivo.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/**
 * Una persona de recepción pasó su tope de salidas en efectivo de la noche
 * (audit_events wallet.reception_payout_cap, una vez por persona y noche):
 * desde ahí, cada salida la confirma el encargado con su 2FA.
 */
export function receptionPayoutCapIncident(r: EventRow & { actorName?: string | null }): Incident {
  const p = r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {};
  const paid = typeof p.nightPaidCents === 'number' ? p.nightPaidCents : null;
  const cap = typeof p.nightCapCents === 'number' ? p.nightCapCents : null;
  const who = r.actorName?.trim() || 'Una persona de recepción';
  const tail = 'Desde ahí, cada salida la confirma el encargado con su 2FA. Revisa sus salidas de esta noche (Clientes → Saldos).';
  const amounts = `${paid === null ? '' : `ya llevaba ${eur(paid)} devueltos`}${cap === null ? '' : `${paid === null ? '' : ' y '}su tope es ${eur(cap)}`}`;
  return {
    kind: 'reception_payout_cap',
    refId: r.id,
    title: 'Recepción pasa su tope de efectivo devuelto esta noche',
    detail: `${who} ${r.amountCents === null ? 'quería devolver más' : `quería devolver ${eur(r.amountCents)}`}${amounts ? ` (${amounts})` : ''}. ${tail}`,
    alertDetail: `${r.amountCents === null ? 'Una salida' : `Una salida de ${eur(r.amountCents)}`}${amounts ? ` (${amounts})` : ''}. ${tail}`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/** «He perdido mi NFC»: el cliente bloqueó su NFC desde su móvil (WalletLostCardService). */
export function walletCardLostIncident(r: EventRow): Incident {
  const code = str(r.payload, 'code');
  const saldo = r.amountCents !== null ? ` (${eur(r.amountCents)})` : '';
  const keeps = 'sigue valiendo con su código y PIN o su Face ID. Si viene a recepción, dale un NFC nuevo con su código.';
  return {
    kind: 'wallet_card_lost',
    refId: r.id,
    title: 'Un cliente ha bloqueado su NFC',
    detail: `Lo marcó como perdido en su móvil, con su Face ID: ya no paga. Su saldo${code ? ` ${code}` : ''}${saldo} ${keeps}`,
    // Telegram es un tercero: sin el código del cliente.
    alertDetail: `Lo marcó como perdido en su móvil, con su Face ID: ya no paga. Su saldo${saldo} ${keeps}`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/**
 * «No he sido yo»: el cliente dice, desde el aviso de un cobro en su móvil,
 * que ese cobro de su saldo no lo hizo él (ChargeDisputeService). Su ficha y
 * su PIN ya no pagan; el dinero no se ha devuelto: lo decide el local.
 */
export function walletChargeDisputedIncident(r: EventRow): Incident {
  const ref = str(r.payload, 'ref');
  const code = str(r.payload, 'code');
  const amount = r.amountCents !== null ? ` de ${eur(r.amountCents)}` : '';
  const what = `El cliente dice que no ha sido él: cobro ${ref ?? 'del saldo'}${amount}`;
  const blocked = 'Su ficha y su PIN ya no pagan (con su Face ID, sí).';
  const todo = 'Revisa el cobro con quien lo hizo y, si procede, devuélvelo. Después, el encargado desbloquea su PIN en Saldos y recepción le da una ficha nueva.';
  return {
    kind: 'wallet_charge_disputed',
    refId: r.id,
    title: 'Un cliente dice que no ha sido él',
    detail: `${what}${code ? ` (saldo ${code})` : ''}. ${blocked} ${todo}`,
    // Telegram es un tercero: sin el código del cliente.
    alertDetail: `${what}. ${blocked} ${todo}`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/** Los avisos por persona (Ajustes → Telegram → Avisos por persona; umbrales en StaffWatchSettings). */
export type StaffPatternRule = 'cancels' | 'free_amount' | 'pin_fails' | 'same_saldo';

/** Una persona del personal que pasó un umbral en una noche (lo calcula IncidentsService.staffPatterns). */
export interface StaffPatternRow {
  rule: StaffPatternRule;
  /** Noche (YYYY-MM-DD, la de las 08:00 de Madrid). */
  night: string;
  userId: string;
  name: string | null;
  /** Cancelados, cobros con «Otro importe», saldos con el PIN fallado o cobros al mismo saldo. */
  count: number;
  /** «Otro importe» cobrado o lo cobrado al mismo saldo en esos minutos; si no, null. */
  amountCents: number | null;
  /** Cobros al mismo saldo: cuál (su código sale solo en el panel). */
  walletId?: string | null;
  shortCode?: string | null;
  lastAt: Date;
}

const SOMEONE = 'Alguien del personal';

const STAFF_PATTERN: Readonly<Record<StaffPatternRule, { title: string; text: (who: string | null, r: StaffPatternRow, code: string) => string }>> = {
  cancels: {
    title: 'Muchas cancelaciones de una persona',
    text: (who, r) => `${who ?? SOMEONE} ha cancelado ${r.count} cobros la noche del ${r.night}. Revisa esos cobros en Hoy → Cobros y habla con esa persona.`,
  },
  free_amount: {
    title: 'Mucho «Otro importe» de una persona',
    text: (who, r) =>
      `${who ?? SOMEONE} ha cobrado ${eur(r.amountCents ?? 0)} con «Otro importe» (tecleado, sin la carta) en ${r.count} cobros la noche del ${r.night}. Comprueba que eran precios del local.`,
  },
  pin_fails: {
    title: 'PIN fallado en varios saldos',
    text: (who, r) =>
      `En el móvil de ${who ?? SOMEONE.toLowerCase()} se ha fallado el PIN de ${r.count} saldos distintos la noche del ${r.night}. Si no lo tecleaban sus clientes, puede estar probando el PIN de otros: revísalo.`,
  },
  same_saldo: {
    title: 'Cobros seguidos al mismo saldo',
    text: (who, r, code) =>
      `${who ?? SOMEONE} ha cobrado ${r.count} veces al mismo saldo${code} en ${STAFF_WATCH_SAME_SALDO_MINUTES} minutos (${eur(r.amountCents ?? 0)}) la noche del ${r.night}. Comprueba con el cliente que lo pidió todo.`,
  },
};

/**
 * Aviso por persona: uno por persona, regla y noche (y saldo, en los cobros
 * seguidos). El nombre y el código del saldo, solo en el panel; en Telegram
 * (un tercero), sin ellos. Se cierra escribiendo qué se hizo.
 */
export function staffPatternIncident(r: StaffPatternRow): Incident {
  const copy = STAFF_PATTERN[r.rule];
  const code = r.shortCode ? ` (${formatWalletCode(r.shortCode)})` : '';
  return {
    kind: 'staff_pattern',
    refId: [r.rule, r.night, r.userId, ...(r.walletId ? [r.walletId] : [])].join(':'),
    title: copy.title,
    detail: copy.text(r.name?.trim() || null, r, code),
    alertDetail: copy.text(null, r, ''),
    occurredAt: r.lastAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/** Lo que dice cada acción delicada: quién (si el registro lo sabe) va delante en el panel, no en Telegram. */
const SENSITIVE_ACTIONS: Readonly<Record<string, { title: string; detail: string }>> = {
  'wallet.charge_without_faceid': {
    title: 'Cobro sin que el cliente confirme',
    detail: 'ha cobrado de un saldo sin Face ID ni PIN, con su 2FA. Comprueba que el cliente estaba delante.',
  },
  'wallet.pin_reset': {
    title: 'PIN de un cliente borrado',
    detail: 'ha borrado el PIN de un saldo, con su 2FA. Comprueba que lo pidió el cliente.',
  },
  'wallet.pin_unlocked': {
    title: 'PIN de un cliente desbloqueado',
    detail: 'ha desbloqueado el PIN de un saldo (tras los fallos o un «No he sido yo»), con su 2FA. Comprueba que el cliente estaba delante.',
  },
  'wallet.relinked': {
    title: 'Enlace nuevo de un saldo',
    detail: 'ha dado un enlace nuevo: el anterior y su Face ID ya no valen. Comprueba que lo pidió el cliente.',
  },
  'wallet.merged_large': {
    title: 'Se han juntado dos saldos',
    detail: 'Un cliente ha pasado el dinero de un saldo a otro, con su Face ID y su PIN o desde el móvil que pagó.',
  },
  'wallet.activation_not_new': {
    title: 'Saldo con dinero activado en un móvil',
    detail: 'Un saldo que no era nuevo ha pasado a un móvil con el QR de recepción. Comprueba quién hizo esa recarga.',
  },
  'wallet.card_copy_suspected': {
    title: 'Posible ficha copiada',
    detail: 'Han acercado una ficha con el código de un saldo y otro número de serie: el cobro se ha rechazado. Si se repite, cambia esa ficha.',
  },
  'payment.manual_reconcile': {
    title: 'Cobro dado por pagado a mano',
    detail: 'ha marcado un cobro como pagado, con su 2FA. Comprueba que está en el portal del banco.',
  },
  'payment.accepted_after_cancel': {
    title: 'Cobro cancelado dado por bueno',
    detail: 'ha dado por bueno un cobro que el banco cobró después de cancelarlo, con su 2FA. Ahora cuenta como pagado.',
  },
  'operator.left_with_balance': {
    title: 'Baja con dinero sin cobrar',
    detail: 'Se ha dado de baja a alguien a quien aún se le debe dinero. Ya no sale en las listas: para pagarle, actívala en Personal, págale y vuelve a darla de baja.',
  },
  'venue.staff_permissions.updated': {
    title: 'Permisos del personal cambiados',
    detail: 'ha cambiado lo que puede hacer el personal (Ajustes → Permisos).',
  },
  'wallet.cash_topup_undone': {
    title: 'Recarga en efectivo deshecha',
    detail: 'ha deshecho una recarga en efectivo nada más hacerla («Me he equivocado»). Comprueba la caja.',
  },
  'venue.night_settings.updated': {
    title: 'Ajustes de la noche cambiados',
    detail: 'ha cambiado los topes sin PIN o la recepción (Ajustes → La noche).',
  },
};

export const SENSITIVE_AUDIT_ACTIONS: readonly string[] = Object.keys(SENSITIVE_ACTIONS);

/** Algo que mueve dinero o abre un saldo sin que el cliente lo confirme: el dueño tiene que poder verlo. */
export function sensitiveActionIncident(r: EventRow & { action: string; actorName?: string | null }): Incident {
  const copy = SENSITIVE_ACTIONS[r.action] ?? { title: 'Acción delicada', detail: 'Revisa el registro.' };
  const startsLower = /^[a-záéíóú]/.test(copy.detail);
  const who = r.actorName?.trim();
  const name = str(r.payload, 'name');
  return {
    kind: 'sensitive_action',
    refId: r.id,
    title: copy.title,
    detail: `${startsLower ? `${who || 'Alguien del personal'} ${copy.detail}` : copy.detail}${name ? ` (${name})` : ''}`,
    // Telegram es un tercero: sin el nombre.
    alertDetail: startsLower ? `Alguien del personal ${copy.detail}` : copy.detail,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.action === 'payment.manual_reconcile' || r.action === 'payment.accepted_after_cancel' ? r.paymentId : null,
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
    detail: `${r.pendingAtClose === 1 ? '1 cobro quedó pendiente' : `${r.pendingAtClose} cobros quedaron pendientes`}. Resuélvelos en Hoy → Cobros.`,
    occurredAt: r.closedAt.toISOString(),
    amountCents: null,
    paymentId: null,
    ackable: true,
  };
}

export function posChargeMismatchIncident(r: EventRow): Incident {
  const op = str(r.payload, 'operationNumber');
  const why = str(r.payload, 'message') ?? 'La venta del datáfono no corresponde al cobro.';
  return {
    kind: 'pos_charge_mismatch',
    refId: r.id,
    title: 'Venta en el datáfono que no cuadra con el cobro',
    detail: `${why}${op ? ` Operación ${op}.` : ''} Anúlala en el datáfono o devuélvela.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

export function posUnmatchedOpIncident(r: EventRow): Incident {
  const op = str(r.payload, 'operationNumber');
  return {
    kind: 'pos_unmatched_op',
    refId: r.id,
    title: `Venta del datáfono que no está en ${BRAND_NAME}`,
    detail: `${r.amountCents === null ? '' : `${eur(r.amountCents)}. `}${op ? `Operación ${op}. ` : ''}Puede ser un cobro hecho sin la app: averigua de quién es.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/**
 * Cobro pagado en el datáfono que no aparece en ningún cuadre de ese datáfono
 * pasadas 24 h: lo único que lo respalda es lo que dijo el propio aparato.
 */
export function posUnreconciledIncident(r: EventRow): Incident {
  const op = str(r.payload, 'operationNumber');
  return {
    kind: 'pos_unreconciled',
    refId: r.id,
    title: 'Cobro del datáfono sin cuadrar',
    detail: `${r.amountCents === null ? '' : `${eur(r.amountCents)}. `}${op ? `Operación ${op}. ` : ''}Pulsa «Cuadrar con el datáfono» en ese datáfono; si no sale en su lista, revísalo antes de pagar a la chica.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: false,
  };
}

/**
 * Se anuló en el datáfono la venta que pagó el cobro, pero aquí sigue pagado:
 * el cliente no ha pagado y la comisión de la chica sigue contando.
 */
export function posVoidedPaidIncident(r: EventRow): Incident {
  const op = str(r.payload, 'operationNumber');
  return {
    kind: 'pos_voided_paid',
    refId: r.id,
    title: 'Venta anulada en el datáfono y el cobro sigue pagado',
    detail: `${r.amountCents === null ? '' : `${eur(r.amountCents)}. `}${op ? `Operación ${op}. ` : ''}El cliente no ha pagado: regístralo como devolución en Hoy → Cobros para descontar la comisión de la chica, o vuelve a cobrarlo.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

/** Saldo de un cliente: lo que hace falta para avisar. */
export interface WalletBalanceRow {
  id: string;
  shortCode: string | null;
  balanceCents: number;
  occurredAt: Date;
  /** De ese saldo, lo que entró con bitcoin: no se devuelve (se queda como saldo para otra noche). */
  bitcoinCents?: number;
}

/** La parte del saldo que entró con bitcoin (decisión del dueño, fase D). */
export const BITCOIN_STAYS_TEXT = 'esta parte entró con bitcoin: se queda como saldo para otra noche, no se devuelve';

/** « · código K7Q-4M2»: como lo ve el cliente en su móvil (con guion); sin código, nada. */
function codeText(shortCode: string | null): string {
  return shortCode ? ` · código ${formatWalletCode(shortCode)}` : '';
}

/**
 * Una devolución del saldo pedida ANTES de que el saldo dejara de devolverse
 * (17-nov-2026: «Me voy», o recepción la dejó para el encargado o «A la
 * tarjeta») y aún sin terminar: se termina en Saldos → «Terminar devolución».
 * Nada nuevo pide una. La parte que entró con bitcoin no se devuelve (se
 * queda como saldo para otra noche): se dice aparte y no cuenta.
 */
export function walletCloseRequestedIncident(r: WalletBalanceRow): Incident {
  const bitcoin = Math.max(0, Math.min(r.balanceCents, r.bitcoinCents ?? 0));
  const refundable = r.balanceCents - bitcoin;
  const where = `${SALDOS_TAB_PATH} → Terminar devolución (en efectivo o a la tarjeta)`;
  const detail =
    bitcoin === 0
      ? `${eur(r.balanceCents)}${codeText(r.shortCode)}. Termínala en ${where}.`
      : refundable === 0
        ? `${eur(r.balanceCents)}${codeText(r.shortCode)}: todo entró con bitcoin. ${capitalize(BITCOIN_STAYS_TEXT)}.`
        : `${eur(r.balanceCents)}${codeText(r.shortCode)}. Termina la devolución de ${eur(refundable)} en ${where}. Los otros ${eur(bitcoin)}: ${BITCOIN_STAYS_TEXT}.`;
  return {
    kind: 'wallet_close_requested',
    refId: r.id,
    title: 'Devolución de saldo pedida antes de la nueva regla',
    detail,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: refundable,
    paymentId: null,
    ackable: false,
  };
}

/** Recarga cobrada sin el NFC del cliente que nadie ha sumado aún a su saldo (se quita sola al asignarla). */
export interface PendingTopUpRow {
  id: string;
  balanceCents: number;
  occurredAt: Date;
}

export function walletTopUpUnassignedIncident(r: PendingTopUpRow): Incident {
  return {
    kind: 'wallet_topup_unassigned',
    refId: r.id,
    title: 'Recarga pendiente de asignar',
    detail: `${eur(r.balanceCents)} cobrados sin el NFC del cliente. Asígnala a su saldo: en Recepción → Pendientes de asignar (acercando su NFC) o en Clientes → Saldos (con su código). El dinero no se pierde: sigue en esa recarga.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.balanceCents,
    paymentId: null,
    ackable: false,
  };
}

/** Una línea del cuadre con el banco que no cuadra. */
export interface BankItemRow {
  id: string;
  status: string;
  kind: string;
  source: string;
  bankAmountCents: number | null;
  oursAmountCents: number | null;
  reference: string | null;
  authCode: string | null;
  paymentId: string | null;
  /** Hora de la operación (null si el fichero no la traía). */
  operationAt: Date | null;
  occurredAt: Date;
}

/**
 * La misma diferencia tiene el mismo identificador aunque se vuelva a subir
 * el fichero: lo marcado como revisado sigue revisado.
 */
export function bankMismatchKey(r: BankItemRow): string {
  return [
    r.source,
    r.status,
    r.kind,
    r.reference ?? '',
    r.paymentId ?? '',
    r.bankAmountCents ?? '',
    r.oursAmountCents ?? '',
    r.reference || r.paymentId ? '' : (r.operationAt?.toISOString() ?? ''),
  ].join('|');
}

const BANK_TEXT: Record<string, { title: string; hint: string }> = {
  NOT_PAID_HERE: {
    title: 'El banco cobró un pago que aquí no consta como pagado',
    hint: 'Ábrelo en Hoy → Cobros y resuélvelo con la autorización del banco.',
  },
  NOT_IN_OXIOPAY: {
    title: `Venta en el banco que no está en ${BRAND_NAME}`,
    hint: 'Se cobró fuera del sistema (o con otro datáfono): averigua quién y por qué.',
  },
  NOT_IN_BANK: {
    title: 'Cobro que el banco no tiene',
    hint: 'Si tampoco está en el portal del banco, no se cobró: no lo pagues a la chica hasta aclararlo.',
  },
  AMOUNT_MISMATCH: {
    title: 'Importe distinto en el banco',
    hint: 'Compara el cobro con la operación del portal del banco.',
  },
  REFUND_NOT_IN_OXIOPAY: {
    title: 'Devolución hecha en el banco sin apuntar',
    hint: 'Si es de un cobro, apúntala en Hoy → Cobros → Devolución BBVA para que cuadre la parte de la compañera. Si es de una recarga, el saldo no se devuelve: averigua quién la hizo en el banco, apúntalo aparte y márcala como revisada.',
  },
  REFUND_NOT_IN_BANK: {
    title: 'Devolución apuntada que el banco no tiene',
    hint: 'Compruébala en el portal del banco: puede que no se llegara a hacer.',
  },
};

/** Lo que no cuadra al comparar el fichero del banco con lo apuntado. */
export function bankMismatchIncident(r: BankItemRow): Incident {
  const text = BANK_TEXT[r.status] ?? { title: 'Diferencia con el banco', hint: '' };
  const source = r.source === 'PAYTEF' ? 'Datáfono (Paytef)' : 'TPV virtual (Redsys)';
  const amounts =
    r.status === 'AMOUNT_MISMATCH'
      ? `Banco ${eur(r.bankAmountCents ?? 0)} · aquí ${eur(r.oursAmountCents ?? 0)}`
      : eur(r.bankAmountCents ?? r.oursAmountCents ?? 0);
  const parts = [
    amounts,
    source,
    r.reference ? `ref. ${r.reference}` : null,
    r.authCode ? `autorización ${r.authCode}` : null,
  ].filter(Boolean);
  return {
    kind: 'bank_mismatch',
    refId: bankMismatchKey(r),
    title: text.title,
    detail: `${parts.join(' · ')}. ${text.hint}`.trim(),
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.bankAmountCents ?? r.oursAmountCents,
    paymentId: r.paymentId,
    ackable: true,
  };
}

/**
 * Copias de seguridad de la base de datos. "Sin copia" se quita sola cuando
 * vuelve a haberla (y avisa una vez al día por Telegram); "no se vigilan"
 * (solo en producción) se puede marcar como revisada.
 */
export function backupIncidents(verdict: BackupVerdict, now: Date, production: boolean): Incident[] {
  if (verdict.kind === 'ok') return [];
  if (verdict.kind === 'unmonitored') {
    if (!production) return [];
    return [
      {
        kind: 'backup_unmonitored',
        refId: 'unmonitored',
        title: 'Las copias de seguridad no se vigilan',
        detail:
          'Activa las copias diarias de la base de datos en Dokploy y pon las variables BACKUP_S3_* del API para que avise si fallan (pasos en docs/BACKUPS.md).',
        occurredAt: now.toISOString(),
        amountCents: null,
        paymentId: null,
        ackable: true,
      },
    ];
  }
  const last = verdict.lastBackupAt
    ? `La última copia es del ${verdict.lastBackupAt.toLocaleString('es-ES', {
        timeZone: 'Europe/Madrid',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })}.`
    : 'No hay ninguna copia en el almacenamiento.';
  const why = verdict.error ? ` No se pudo consultar el almacenamiento (${verdict.error}).` : '';
  return [
    {
      kind: 'backup_stale',
      refId: `stale:${madridDay(now)}`,
      title: 'Sin copia de seguridad reciente de la base de datos',
      detail: `${last}${why} Revisa Dokploy → nightpay-postgres → Backups.`,
      occurredAt: now.toISOString(),
      amountCents: null,
      paymentId: null,
      ackable: false,
    },
  ];
}

/**
 * Avisos de cobro aprobado que NO se dieron por buenos (procesador de avisos,
 * payment_events con estos tipos): el banco puede haber cobrado y aquí el
 * cobro no consta como pagado.
 */
export interface PaymentAnomalyRow extends EventRow {
  eventType: string;
  /** El estado del cobro ahora (bitcoin: si ya estaba cerrado cuando llegó). Sin el campo, no se sabe. */
  paymentStatus?: string;
  /** La referencia corta del cobro (17 → «C-0017»). */
  ref?: number | null;
}

/** Quién avisa y dónde comprobarlo, por pasarela. */
const PROVIDER_TEXT: Record<string, { who: string; where: string }> = {
  REDSYS: { who: 'El banco (Redsys)', where: 'el portal del banco' },
  PAYTEF: { who: 'Paytef', where: 'el panel de Paytef' },
  PEANPE: { who: 'Peanpe', where: 'el panel de Peanpe' },
  WIPAY: { who: 'Cecabank', where: 'el portal de Cecabank' },
  BTCPAY: { who: 'Tu BTCPay (bitcoin)', where: 'tu BTCPay y la cartera del local' },
};
const UNKNOWN_PROVIDER_TEXT = { who: 'La pasarela', where: 'el panel de la pasarela' };

const STATUS_TEXT: Record<string, string> = {
  EXPIRED: 'caducado',
  CANCELED: 'cancelado',
  CREATED: 'sin empezar',
  AWAITING_CAPTURE: 'sin empezar',
  // Bitcoin que llega a un cobro que el cliente ya pagó con tarjeta (o de otra forma): ese bitcoin sobra.
  AUTHORIZED: 'ya pagado de otra forma',
  PARTIALLY_REFUNDED: 'ya pagado de otra forma',
  REFUNDED: 'ya pagado de otra forma',
};

function num(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * «Pagó después de cancelar: C-0012, 12,00 €» (paid-after-cancel.ts): el
 * personal canceló el cobro y el banco lo cobró después. Sigue cancelado; se
 * cierra con una nota (devuelto en el banco o dado por bueno). Sin datos del
 * cliente: va también a Telegram.
 */
function paidAfterCancelIncident(
  r: PaymentAnomalyRow,
  base: { occurredAt: string; paymentId: string | null },
  where: string,
  orderText: string,
): Incident {
  const charged = num(r.payload, 'amountCents') ?? r.amountCents;
  const ref = formatChargeRef(r.ref ?? null) ?? 'un cobro';
  const still = r.paymentStatus === undefined || r.paymentStatus === 'CANCELED';
  return {
    ...base,
    kind: 'approval_unbooked',
    refId: r.id,
    title: `Pagó después de cancelar: ${ref}${charged === null ? '' : `, ${eur(charged)}`}`,
    detail: still
      ? `El cliente terminó de pagar en su banco después de cancelar el cobro${orderText}. El cobro sigue cancelado: no se ha devuelto ni se ha dado por pagado. Devuélveselo desde ${where} o, si se queda, dalo por bueno. Ciérrala diciendo qué hiciste.`
      : `El cliente terminó de pagar en su banco después de cancelar el cobro${orderText}. Ya está dado por bueno: ciérrala con una nota.`,
    amountCents: charged,
    ackable: true,
    ...(still ? { acceptable: true } : {}),
  };
}

export function paymentAnomalyIncident(r: PaymentAnomalyRow): Incident {
  const provider = PROVIDER_TEXT[str(r.payload, 'provider') ?? ''] ?? UNKNOWN_PROVIDER_TEXT;
  const order = str(r.payload, 'providerTxId');
  const orderText = order ? ` (pedido ${order})` : '';
  const base = { occurredAt: r.occurredAt.toISOString(), paymentId: r.paymentId };
  if (str(r.payload, 'provider') === 'BTCPAY') {
    const btc = bitcoinAnomalyIncident(r, base);
    if (btc) return btc;
  }

  if (r.eventType === 'payment.amount_mismatch') {
    const charged = num(r.payload, 'chargedCents');
    const expected = num(r.payload, 'expectedCents');
    const currency = str(r.payload, 'chargedCurrency');
    const other = currency && currency !== 'EUR' ? ` (${currency})` : '';
    return {
      ...base,
      kind: 'amount_mismatch',
      refId: r.id,
      title: 'El banco aprobó un importe distinto',
      detail: `Aprobado ${charged === null ? '?' : eur(charged)}${other} · el cobro era de ${expected === null ? '?' : eur(expected)}${orderText}. No se ha dado por pagado: compruébalo en ${provider.where} y resuélvelo en Hoy → Cobros → Resolver (o devuelve el cargo).`,
      amountCents: charged ?? r.amountCents,
      ackable: true,
    };
  }
  if (r.eventType === 'payment.approval_unbooked' && str(r.payload, 'reason') === 'paid_with_saldo') {
    // Cobro único: lo pagó el saldo y el banco aprobó también la tarjeta.
    const charged = num(r.payload, 'amountCents') ?? r.amountCents;
    return {
      ...base,
      kind: 'approval_unbooked',
      refId: r.id,
      title: 'Cobrado dos veces: con el saldo y con la tarjeta',
      detail: `El cliente pagó este cobro con su saldo y después el banco aprobó también la tarjeta${orderText}. Devuélvele ${charged === null ? 'el cargo' : eur(charged)} a la tarjeta desde ${provider.where}; el saldo ya está bien.`,
      amountCents: charged,
      ackable: true,
    };
  }
  if (r.eventType === 'payment.approval_unbooked' && str(r.payload, 'reason') === PAID_AFTER_CANCEL_REASON) {
    return paidAfterCancelIncident(r, base, provider.where, orderText);
  }
  if (r.eventType === 'payment.approval_unbooked') {
    const status = STATUS_TEXT[str(r.payload, 'fromStatus') ?? ''] ?? 'cerrado';
    return {
      ...base,
      kind: 'approval_unbooked',
      refId: r.id,
      title: 'El banco cobró un pago que aquí no se pudo apuntar',
      detail: `${r.amountCents === null ? '' : `${eur(r.amountCents)}. `}El cobro estaba ${status} cuando llegó la aprobación${orderText}. Devuélveselo al cliente desde ${provider.where}.`,
      amountCents: r.amountCents,
      ackable: true,
    };
  }
  // payment.approval_unverified de una factura de bitcoin: pago a medias, tardío o factura que no cuadra.
  if (str(r.payload, 'source') === 'btcpay') {
    const reason = str(r.payload, 'reason') ?? '';
    const BTC_REASONS: Record<string, { title: string; what: string }> = {
      'btcpay-paid_partial': { title: 'Pago de bitcoin a medias', what: 'El cliente envió menos bitcoin de lo que costaba el cobro.' },
      'btcpay-marked': { title: 'Factura de bitcoin marcada como pagada a mano', what: 'Marcada como pagada a mano en BTCPay: compruébalo antes de darla por buena.' },
      'btcpay-paid_late': { title: 'Pago de bitcoin fuera de plazo', what: 'El cliente pagó cuando la factura de bitcoin ya había caducado.' },
    };
    const known = BTC_REASONS[reason];
    return {
      ...base,
      kind: 'approval_unverified',
      refId: r.paymentId ?? r.id,
      title: known?.title ?? 'Una factura de bitcoin no cuadra con el cobro',
      detail: `${known?.what ?? 'BTCPay avisa de una factura cuyo importe, moneda o tienda no coinciden con el cobro.'} NO se ha dado por pagado${r.amountCents === null ? '' : ` (${eur(r.amountCents)})`}${orderText}. Míralo en ${provider.where}: lo recibido se devuelve en euros (nunca en bitcoin) y se cancela el cobro, o, si ya está todo cobrado, resuélvelo en Hoy → Cobros → Resolver.`,
      amountCents: r.amountCents,
      ackable: false,
    };
  }
  // payment.approval_unverified: uno por cobro; se quita solo al resolverlo.
  if (str(r.payload, 'source') === 'pos-device') {
    const op = str(r.payload, 'operationNumber');
    return {
      ...base,
      kind: 'approval_unverified',
      refId: r.paymentId ?? r.id,
      title: 'Recarga del datáfono sin comprobar',
      detail: `El datáfono dice que cobró${r.amountCents === null ? '' : ` ${eur(r.amountCents)}`} con tarjeta${op ? ` (operación ${op})` : ''}, pero Paytef no lo ha confirmado y NO se ha sumado al saldo. Míralo en el panel de Paytef y, si está cobrado, resuélvelo en Hoy → Cobros → Resolver con su código de autorización.`,
      amountCents: r.amountCents,
      ackable: false,
    };
  }
  return {
    ...base,
    kind: 'approval_unverified',
    refId: r.paymentId ?? r.id,
    title: 'Aviso de pago sin comprobar',
    detail: `${provider.who} avisa de que el cliente pagó${r.amountCents === null ? '' : ` ${eur(r.amountCents)}`}, pero no se ha podido comprobar y NO se ha dado por pagado. Míralo en ${provider.where}${orderText} y, si está cobrado, resuélvelo en Hoy → Cobros → Resolver.`,
    amountCents: r.amountCents,
    ackable: false,
  };
}

/** Cobros de las chicas dados por pagados con la palabra del datáfono, por noche. */
export interface UnprovenSalesRow {
  /** Noche (YYYY-MM-DD, la de las 08:00 de Madrid). */
  night: string;
  count: number;
  amountCents: number;
  lastAt: Date;
}

export function posUnprovenSalesIncident(r: UnprovenSalesRow): Incident {
  const many = r.count === 1 ? '1 venta' : `${r.count} ventas`;
  return {
    kind: 'pos_unproven_sales',
    refId: r.night,
    title: 'Ventas por datáfono sin cuadrar con el banco',
    detail: `${many} por datáfono (${eur(r.amountCents)}) de la noche del ${r.night} sin prueba del banco (las confirmó un camarero con el ticket o el datáfono sin poder comprobarlo con Paytef). La comisión de las chicas está retenida: se paga al cuadrarlas con el fichero del banco (Banco) o si las liberas en Personal → la chica (con tu 2FA).`,
    occurredAt: r.lastAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

const LIMIT_TEXT: Record<string, string> = {
  rate: 'el tope de recargas por minuto',
  terminal_daily: 'el tope de recargas del datáfono en 24 h',
  wallet_daily: 'el tope de recargas de un saldo en 24 h',
};

/** Un datáfono de recepción pasó un tope (audit_events pos.reception_limit_exceeded). */
export function posReceptionLimitIncident(r: EventRow): Incident {
  const limit = LIMIT_TEXT[str(r.payload, 'limit') ?? ''] ?? 'un tope de recargas';
  const label = str(r.payload, 'terminalLabel');
  return {
    kind: 'pos_reception_limit',
    refId: r.id,
    title: 'Datáfono de recepción frenado por un tope',
    detail: `${label ? `«${label}»` : 'Un datáfono'} ha pasado ${limit}${r.amountCents === null ? '' : ` (pedía ${eur(r.amountCents)})`} y no se ha cobrado. Si no es de la recepción o no lo reconoces, desvincúlalo en Datáfonos.`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: true,
  };
}

/**
 * Una devolución por la pasarela sigue PENDING pasado este rato: la pasarela
 * no contestó (o contestó y no se pudo apuntar en el cobro). Normalmente se
 * confirma en segundos; el dueño puede resolverla a mano a partir de 2 min.
 */
export const REFUND_PENDING_MINUTES = 5;

/** Devolución por la pasarela que sigue PENDING (reservando importe del cobro). */
export interface PendingRefundRow {
  id: string;
  paymentId: string;
  amountCents: number;
  /** Lo cobrado (importe + propina). */
  paymentAmountCents: number;
  provider: string | null;
  providerTxId: string | null;
  /** La pasarela dijo que la hizo, pero no se pudo apuntar en el cobro (refund.settle_failed). */
  settleFailed: boolean;
  createdAt: Date;
}

function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} días`;
}

/**
 * Sale a los REFUND_PENDING_MINUTES y se quita sola al resolverla (deja de
 * estar PENDING). refId = id de la devolución: una por devolución, y Telegram
 * la avisa una sola vez.
 */
export function refundPendingIncident(r: PendingRefundRow, now: Date): Incident {
  const provider = PROVIDER_TEXT[r.provider ?? ''] ?? UNKNOWN_PROVIDER_TEXT;
  const order = r.providerTxId ? ` (pedido ${r.providerTxId})` : '';
  const what = `${eur(r.amountCents)} del cobro de ${eur(r.paymentAmountCents)}${order}, hace ${elapsed(now.getTime() - r.createdAt.getTime())}.`;
  const todo = r.settleFailed
    ? `${provider.who} dice que la hizo, pero no se pudo apuntar en el cobro: compruébalo en ${provider.where} y pulsa Resolver → Hecha. No la repitas.`
    : `Revisa en ${provider.where} si se hizo y pulsa Resolver en el cobro. Mientras, ese importe no se puede volver a devolver.`;
  return {
    kind: 'refund_pending',
    refId: r.id,
    title: 'Devolución sin confirmar del banco',
    detail: `${what} ${todo}`,
    occurredAt: r.createdAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: r.paymentId,
    ackable: false,
  };
}

/** Solicitud de «Por aprobar» sin decidir (pedida por el encargado, sin caducar). */
export interface PendingApprovalRow {
  id: string;
  kind: 'PAYOUT' | 'REFUND';
  amountCents: number;
  requestedAt: Date;
  /** Quien la pidió (nombre visible o principio del email). */
  requester: string | null;
  /** La chica, en las de pago. */
  operatorName: string | null;
}

/**
 * Sale a los APPROVAL_INCIDENT_MINUTES (30) y se quita sola al aprobarla,
 * rechazarla o caducar (24 h). refId = id de la solicitud: Telegram la avisa
 * una sola vez (la misma marca que el aviso de cuando se pidió).
 */
export function approvalPendingIncident(r: PendingApprovalRow, now: Date): Incident {
  const payout = r.kind === 'PAYOUT';
  const text = (operatorName: string | null): string => {
    const what = payout ? `pagar ${eur(r.amountCents)} a ${operatorName ?? 'una chica'}` : `devolver ${eur(r.amountCents)}`;
    return `${r.requester ?? 'El encargado'} pidió ${what} hace ${elapsed(now.getTime() - r.requestedAt.getTime())}. Apruébalo o recházalo en «Por aprobar»: caduca a las 24 h.`;
  };
  return {
    kind: 'approval_pending',
    refId: r.id,
    title: payout ? 'Pago a una chica por aprobar' : 'Devolución por aprobar',
    detail: text(r.operatorName),
    occurredAt: r.requestedAt.toISOString(),
    amountCents: r.amountCents,
    paymentId: null,
    ackable: false,
    ...(payout && r.operatorName ? { alertDetail: text(null) } : {}),
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
