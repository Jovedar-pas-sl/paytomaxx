/**
 * Bandeja de incidencias (Fase 1E): lo que el dueño tiene que mirar. Se
 * calcula al vuelo desde cobros, avisos y registros; las que no se resuelven
 * solas (un doble cobro, un descuento que falló…) se marcan como revisadas.
 */

import { BRAND_NAME } from '../../common/brand';
import { madridDay } from '../../common/time/madrid';
import type { BackupVerdict } from '../db-backups/backup-check';

export type IncidentKind =
  | 'stuck_payment'
  | 'duplicate_charge'
  | 'earning_reverse_failed'
  | 'wallet_credit_skipped'
  | 'night_closed_pending'
  | 'pos_charge_mismatch'
  | 'pos_unmatched_op'
  | 'pos_unreconciled'
  | 'wallet_close_requested'
  | 'wallet_open_balance'
  | 'bank_mismatch'
  | 'backup_stale'
  | 'backup_unmonitored'
  | 'approval_unverified'
  | 'amount_mismatch'
  | 'approval_unbooked'
  | 'refund_pending';

/** Las que desaparecen solas al resolverse (no se marcan como revisadas). */
export const SELF_RESOLVING: ReadonlySet<IncidentKind> = new Set<IncidentKind>([
  'stuck_payment',
  'pos_unreconciled',
  'wallet_close_requested',
  'wallet_open_balance',
  'backup_stale',
  'approval_unverified',
  'refund_pending',
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
  'bank_mismatch',
  'backup_unmonitored',
  'amount_mismatch',
  'approval_unbooked',
] as const satisfies readonly IncidentKind[];

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

/** Saldo de un cliente: lo que hace falta para avisar. */
export interface WalletBalanceRow {
  id: string;
  shortCode: string | null;
  balanceCents: number;
  occurredAt: Date;
}

/** El cliente pulsó "Me voy": hay que devolverle el saldo. */
export function walletCloseRequestedIncident(r: WalletBalanceRow): Incident {
  return {
    kind: 'wallet_close_requested',
    refId: r.id,
    title: 'Un cliente pide que le devuelvan su saldo',
    detail: `${eur(r.balanceCents)}${r.shortCode ? ` · código ${r.shortCode}` : ''}. Devuélveselo en Wallets → Devolver saldo (tarjeta o efectivo).`,
    occurredAt: r.occurredAt.toISOString(),
    amountCents: r.balanceCents,
    paymentId: null,
    ackable: false,
  };
}

/** Saldo que nadie ha devuelto tras cerrar la noche (08:00): que no se olvide. */
export function walletOpenBalanceIncident(r: WalletBalanceRow): Incident {
  return {
    kind: 'wallet_open_balance',
    refId: r.id,
    title: 'Saldo de un cliente sin devolver',
    detail: `${eur(r.balanceCents)}${r.shortCode ? ` · código ${r.shortCode}` : ''}. Si el cliente ya se fue, devuélveselo a la tarjeta en Wallets → Devolver saldo.`,
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
    hint: 'Ábrelo en Pagos y resuélvelo con la autorización del banco.',
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
    hint: 'Apúntala en Pagos → Devolución hecha en BBVA para que cuadre la parte de la chica.',
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
}

/** Quién avisa y dónde comprobarlo, por pasarela. */
const PROVIDER_TEXT: Record<string, { who: string; where: string }> = {
  REDSYS: { who: 'El banco (Redsys)', where: 'el portal del banco' },
  PAYTEF: { who: 'Paytef', where: 'el panel de Paytef' },
  PEANPE: { who: 'Peanpe', where: 'el panel de Peanpe' },
  WIPAY: { who: 'Cecabank', where: 'el portal de Cecabank' },
};
const UNKNOWN_PROVIDER_TEXT = { who: 'La pasarela', where: 'el panel de la pasarela' };

const STATUS_TEXT: Record<string, string> = {
  EXPIRED: 'caducado',
  CANCELED: 'cancelado',
  CREATED: 'sin empezar',
  AWAITING_CAPTURE: 'sin empezar',
};

function num(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function paymentAnomalyIncident(r: PaymentAnomalyRow): Incident {
  const provider = PROVIDER_TEXT[str(r.payload, 'provider') ?? ''] ?? UNKNOWN_PROVIDER_TEXT;
  const order = str(r.payload, 'providerTxId');
  const orderText = order ? ` (pedido ${order})` : '';
  const base = { occurredAt: r.occurredAt.toISOString(), paymentId: r.paymentId };

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
      detail: `Aprobado ${charged === null ? '?' : eur(charged)}${other} · el cobro era de ${expected === null ? '?' : eur(expected)}${orderText}. No se ha dado por pagado: compruébalo en ${provider.where} y resuélvelo en Pagos → Resolver (o devuelve el cargo).`,
      amountCents: charged ?? r.amountCents,
      ackable: true,
    };
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
  // payment.approval_unverified: uno por cobro; se quita solo al resolverlo.
  return {
    ...base,
    kind: 'approval_unverified',
    refId: r.paymentId ?? r.id,
    title: 'Aviso de pago sin comprobar',
    detail: `${provider.who} avisa de que el cliente pagó${r.amountCents === null ? '' : ` ${eur(r.amountCents)}`}, pero no se ha podido comprobar y NO se ha dado por pagado. Míralo en ${provider.where}${orderText} y, si está cobrado, resuélvelo en Pagos → Resolver.`,
    amountCents: r.amountCents,
    ackable: false,
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

/** Más recientes primero; quita las ya revisadas. */
export function openIncidents(all: ReadonlyArray<Incident>, acked: ReadonlySet<string>): Incident[] {
  return all
    .filter((i) => !i.ackable || !acked.has(ackKey(i.kind, i.refId)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function ackKey(kind: string, refId: string): string {
  return `${kind}:${refId}`;
}
