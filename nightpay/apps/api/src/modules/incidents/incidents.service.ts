import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { APPROVAL_INCIDENT_MINUTES, APPROVAL_TTL_MS, PENDING_TOPUP_INCIDENT_MINUTES } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lastNightCutoff } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { BackupMonitorService } from '../db-backups/backup-monitor.service';
import { paymentBankHeldSql } from '../operators/bank-hold-sql';
import {
  MIN_ACK_NOTE_LENGTH,
  SELF_RESOLVING,
  ackKey,
  ackNeedsNote,
  duplicateChargeIncident,
  cashSplitIncident,
  sensitiveActionIncident,
  SENSITIVE_AUDIT_ACTIONS,
  receptionPayoutCapIncident,
  earningReverseFailedIncident,
  nightClosedPendingIncident,
  openIncidents,
  posChargeMismatchIncident,
  posUnmatchedOpIncident,
  posUnreconciledIncident,
  posVoidedPaidIncident,
  walletCloseRequestedIncident,
  walletOpenBalanceIncident,
  bankMismatchIncident,
  backupIncidents,
  paymentAnomalyIncident,
  refundPendingIncident,
  approvalPendingIncident,
  REFUND_PENDING_MINUTES,
  type PendingApprovalRow,
  type BankItemRow,
  type PendingRefundRow,
  type PaymentAnomalyRow,
  type WalletBalanceRow,
  stuckIncident,
  walletCreditSkippedIncident,
  walletTopUpUnassignedIncident,
  walletCardLostIncident,
  type PendingTopUpRow,
  posReceptionLimitIncident,
  posUnprovenSalesIncident,
  type UnprovenSalesRow,
  type EventRow,
  type Incident,
  type IncidentKind,
  type NightPendingRow,
  type StuckRow,
} from './incident-rules';
import { runLimited } from './run-limited';

/** Hasta dónde se mira atrás, y cuántas de cada tipo como mucho. */
const LOOKBACK_DAYS = 60;
const PER_KIND_LIMIT = 100;
/** Un cobro esperando al banco más de esto se da por atascado (como en Pagos → Resolver). */
const STUCK_MINUTES = 15;
/** Un cobro del datáfono debería salir en un cuadre de ese datáfono en este tiempo. */
const RECONCILE_WITHIN_HOURS = 24;
/**
 * Consultas de la bandeja a la vez. Eran las 17 en un Promise.all: 17
 * conexiones del pool de Prisma en cada carga del panel y en cada vuelta de
 * 5 min de las alertas por local, y los cobros esperaban conexión.
 */
export const INCIDENT_QUERY_CONCURRENCY = 4;

/**
 * Bandeja de incidencias (Fase 1E). Se calcula al vuelo para un local;
 * SQL crudo con el local explícito (también la usan las alertas, fuera de
 * una petición).
 */
@Injectable()
export class IncidentsService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly backups: BackupMonitorService | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Optional() @Inject(BackupMonitorService) backups?: BackupMonitorService,
  ) {
    this.backups = backups ?? null;
    this.prisma = prisma;
    this.audit = audit;
  }

  async list(tenantId: string, now: Date = new Date()): Promise<Incident[]> {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const stuckBefore = new Date(now.getTime() - STUCK_MINUTES * 60 * 1000);
    const reconcileBefore = new Date(now.getTime() - RECONCILE_WITHIN_HOURS * 60 * 60 * 1000);
    const refundPendingBefore = new Date(now.getTime() - REFUND_PENDING_MINUTES * 60 * 1000);
    const nightStart = lastNightCutoff(now);
    const approvalPendingBefore = new Date(now.getTime() - APPROVAL_INCIDENT_MINUTES * 60 * 1000);
    const approvalExpiredBefore = new Date(now.getTime() - APPROVAL_TTL_MS);
    const unassignedBefore = new Date(now.getTime() - PENDING_TOPUP_INCIDENT_MINUTES * 60 * 1000);
    const [
      stuck,
      duplicates,
      auditRows,
      nights,
      acks,
      posMismatches,
      posUnmatched,
      posUnreconciled,
      walletsToClose,
      walletsLeftOpen,
      bankItems,
      anomalies,
      pendingRefunds,
      pendingApprovals,
      posVoidedPaid,
      unprovenSales,
      unassignedTopUps,
    ] = await runLimited([
      () => this.prisma.$queryRaw<StuckRow[]>`
        SELECT id, status::text AS status, "amountCents", "updatedAt"
          FROM payments
         WHERE "tenantId" = ${tenantId}::uuid
           AND "createdAt" >= ${since}
           AND (status = 'ORPHAN'
                OR (status = 'AUTHORIZING' AND "updatedAt" < ${stuckBefore}))
         ORDER BY "updatedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      () => this.prisma.$queryRaw<EventRow[]>`
        SELECT e.id::text AS id, e."paymentId", (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "amountCents",
               e."occurredAt", e.payload
          FROM payment_events e
          JOIN payments p ON p.id = e."paymentId"
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."eventType" = 'payment.duplicate_charge'
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = e."tenantId" AND k.kind = 'duplicate_charge'
                              AND k."refId" = e.id::text)
           -- Doble cobro en el datáfono ya anulado allí: resuelto.
           AND NOT EXISTS (SELECT 1 FROM payment_events v
                            WHERE v."paymentId" = e."paymentId" AND v."eventType" = 'pos.voided'
                              AND v.payload ->> 'operationNumber' = e.payload ->> 'order')
           AND e."occurredAt" >= ${since}
         ORDER BY e."occurredAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      () => this.prisma.$queryRaw<Array<EventRow & { action: string; actorName: string | null }>>`
        SELECT a.id::text AS id, a.action, a."targetId" AS "paymentId",
               CASE WHEN jsonb_typeof(a.payload -> 'amountCents') = 'number'
                    THEN (a.payload ->> 'amountCents')::int END AS "amountCents",
               a."occurredAt", a.payload,
               (SELECT COALESCE(NULLIF(btrim(u."displayName"), ''), split_part(u.email, '@', 1))
                  FROM users u WHERE u.id = a."actorId") AS "actorName"
          FROM audit_events a
         WHERE a."tenantId" = ${tenantId}::uuid
           AND (a.action IN ('refund.earning_reverse_failed', 'wallet.credit_skipped_critical',
                             'pos.reception_limit_exceeded', 'wallet.cash_split_suspected',
                             'wallet.reception_payout_cap', 'wallet.card_blocked_by_client')
                OR (a.action = ANY(${[...SENSITIVE_AUDIT_ACTIONS]}::text[])
                    -- «No se cobró» no sube ningún saldo: no hace falta avisar.
                    AND COALESCE(a.payload ->> 'decision', 'AUTHORIZED') = 'AUTHORIZED'))
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = a."tenantId"
                              AND k.kind IN ('earning_reverse_failed', 'wallet_credit_skipped', 'pos_reception_limit',
                                             'cash_split_suspected', 'reception_payout_cap', 'wallet_card_lost', 'sensitive_action')
                              AND k."refId" = a.id::text)
           AND a."occurredAt" >= ${since}
         ORDER BY a."occurredAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      () => this.prisma.$queryRaw<NightPendingRow[]>`
        SELECT id, "closedAt", "pendingAtClose", "autoClosed"
          FROM venue_nights
         WHERE "tenantId" = ${tenantId}::uuid
           AND "closedAt" IS NOT NULL
           AND "pendingAtClose" > 0
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = venue_nights."tenantId" AND k.kind = 'night_closed_pending'
                              AND k."refId" = venue_nights.id::text)
           AND "closedAt" >= ${since}
         ORDER BY "closedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      () => this.prisma.$queryRaw<Array<{ kind: string; refId: string }>>`
        SELECT kind, "refId" FROM incident_acks WHERE "tenantId" = ${tenantId}::uuid
      `,
      () => this.prisma.$queryRaw<EventRow[]>`
        SELECT e.id::text AS id, e."paymentId", NULL::int AS "amountCents", e."occurredAt", e.payload
          FROM payment_events e
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."eventType" = 'pos.charge_mismatch'
           AND e."occurredAt" >= ${since}
           AND NOT EXISTS (SELECT 1 FROM payment_events v
                            WHERE v."paymentId" = e."paymentId" AND v."eventType" = 'pos.voided'
                              AND v.payload ->> 'operationNumber' = e.payload ->> 'operationNumber')
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = e."tenantId" AND k.kind = 'pos_charge_mismatch'
                              AND k."refId" = e.id::text)
         ORDER BY e."occurredAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      () => this.prisma.$queryRaw<EventRow[]>`
        SELECT o.id::text AS id, NULL::uuid AS "paymentId", o."amountCents",
               COALESCE(o."occurredAt", o."reportedAt") AS "occurredAt",
               jsonb_build_object('operationNumber', o."operationNumber") AS payload
          FROM pos_terminal_ops o
         WHERE o."tenantId" = ${tenantId}::uuid
           AND o."opType" = 'sale'
           AND o."reportedAt" >= ${since}
           AND NOT EXISTS (SELECT 1 FROM payments p
                            WHERE p."posTerminalId" = o."terminalId" AND p."posOperationNumber" = o."operationNumber")
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = o."tenantId" AND k.kind = 'pos_unmatched_op'
                              AND k."refId" = o.id::text)
         ORDER BY o."reportedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      () => this.prisma.$queryRaw<EventRow[]>`
        SELECT p.id::text AS id, p.id AS "paymentId", (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "amountCents",
               p."authorizedAt" AS "occurredAt",
               jsonb_build_object('operationNumber', p."posOperationNumber") AS payload
          FROM payments p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."posOperationNumber" IS NOT NULL
           AND p."authorizedAt" >= ${since}
           AND p."authorizedAt" < ${reconcileBefore}
           AND NOT EXISTS (SELECT 1 FROM pos_terminal_ops o
                            WHERE o."terminalId" = p."posTerminalId"
                              AND o."operationNumber" = p."posOperationNumber"
                              AND (o."amountCents" IS NULL
                                   OR o."amountCents" = p."amountCents" + p."serviceFeeCents" + p."tipCents"))
         ORDER BY p."authorizedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // client_wallets tiene FORCE RLS: se lee con bypass y se filtra por local aquí.
      () => this.prisma.asSystem((tx) => tx.$queryRaw<WalletBalanceRow[]>`
        SELECT id, "shortCode", "balanceCents", "closeRequestedAt" AS "occurredAt"
          FROM client_wallets
         WHERE "tenantId" = ${tenantId}::uuid
           AND status = 'ACTIVE'
           AND "balanceCents" > 0
           AND "closeRequestedAt" IS NOT NULL
         ORDER BY "closeRequestedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `),
      // Saldo con dinero que no se ha movido desde antes de las últimas 08:00.
      () => this.prisma.asSystem((tx) => tx.$queryRaw<WalletBalanceRow[]>`
        SELECT id, "shortCode", "balanceCents", "updatedAt" AS "occurredAt"
          FROM client_wallets
         WHERE "tenantId" = ${tenantId}::uuid
           AND status = 'ACTIVE'
           AND "balanceCents" > 0
           AND "closeRequestedAt" IS NULL
           AND "pendingAssignAt" IS NULL
           AND "updatedAt" < ${nightStart}
           AND "updatedAt" >= ${since}
         ORDER BY "updatedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `),
      // Cuadre con el banco: lo que no cuadra (si un fichero posterior cubre
      // ese día, deja de contar; "cobrado y aquí sin pagar" se quita al resolverlo).
      () => this.prisma.$queryRaw<BankItemRow[]>`
        SELECT i.id, i.status, i.kind, s.source, i."bankAmountCents", i."oursAmountCents", i.reference,
               i."authCode", i."paymentId", i."occurredAt" AS "operationAt",
               COALESCE(i."occurredAt", i."createdAt") AS "occurredAt"
          FROM bank_statement_items i
          JOIN bank_statements s ON s.id = i."statementId"
          LEFT JOIN payments p ON p.id = i."paymentId"
         WHERE i."tenantId" = ${tenantId}::uuid
           AND i."supersededAt" IS NULL
           AND i.status IN ('NOT_PAID_HERE', 'NOT_IN_OXIOPAY', 'NOT_IN_BANK', 'AMOUNT_MISMATCH',
                            'REFUND_NOT_IN_OXIOPAY', 'REFUND_NOT_IN_BANK')
           AND NOT (i.status = 'NOT_PAID_HERE'
                    AND p.status::text IN ('AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'))
           AND i."createdAt" >= ${since}
         ORDER BY COALESCE(i."occurredAt", i."createdAt") DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // Avisos de cobro aprobado que no se dieron por buenos (webhook-ingest).
      // "Sin comprobar" se quita sola cuando el cobro se resuelve.
      () => this.prisma.$queryRaw<PaymentAnomalyRow[]>`
        SELECT e.id::text AS id, e."eventType", e."paymentId",
               (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "amountCents", e."occurredAt", e.payload
          FROM payment_events e
          JOIN payments p ON p.id = e."paymentId"
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."eventType" IN ('payment.approval_unverified', 'payment.amount_mismatch', 'payment.approval_unbooked')
           AND e."occurredAt" >= ${since}
           AND (e."eventType" <> 'payment.approval_unverified' OR p.status::text IN ('AUTHORIZING', 'ORPHAN'))
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = e."tenantId"
                              AND k.kind IN ('amount_mismatch', 'approval_unbooked')
                              AND k."refId" = e.id::text)
         ORDER BY e."occurredAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // Devoluciones por la pasarela sin confirmar (refund.outcome_unknown) o
      // hechas y sin apuntar (refund.settle_failed). Sin límite de antigüedad:
      // mientras sigan PENDING reservan importe del cobro. Se quitan al resolverlas.
      () => this.prisma.$queryRaw<PendingRefundRow[]>`
        SELECT r.id::text AS id, r."paymentId"::text AS "paymentId", r."amountCents",
               (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "paymentAmountCents",
               p.provider::text AS provider, p."providerTxId", r."createdAt",
               EXISTS (SELECT 1 FROM audit_events a
                        WHERE a.action = 'refund.settle_failed'
                          AND a."tenantId" = r."tenantId"
                          AND a."targetId" = r."paymentId"::text
                          AND a.payload ->> 'refundId' = r.id::text) AS "settleFailed"
          FROM refunds r
          JOIN payments p ON p.id = r."paymentId"
         WHERE r."tenantId" = ${tenantId}::uuid
           AND r.status = 'PENDING'
           AND r."registeredManually" = false
           AND r."createdAt" < ${refundPendingBefore}
         ORDER BY r."createdAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // «Por aprobar» sin decidir desde hace más de 30 min (y sin caducar).
      // approval_requests tiene FORCE RLS: con bypass y filtrando por local aquí.
      () => this.prisma.asSystem((tx) => tx.$queryRaw<PendingApprovalRow[]>`
        SELECT a.id::text AS id, a.kind::text AS kind, a."amountCents", a."requestedAt",
               COALESCE(NULLIF(btrim(u."displayName"), ''), split_part(u.email, '@', 1)) AS requester,
               a.payload ->> 'operatorName' AS "operatorName"
          FROM approval_requests a
          LEFT JOIN users u ON u.id = a."requestedById"
         WHERE a."tenantId" = ${tenantId}::uuid
           AND a.status = 'PENDING'
           AND a."requestedAt" < ${approvalPendingBefore}
           AND a."requestedAt" > ${approvalExpiredBefore}
         ORDER BY a."requestedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `),
      // Venta anulada en el datáfono que era la que pagó el cobro, y el cobro
      // sigue pagado (sin devolver del todo): aquí nada lo deshizo.
      () => this.prisma.$queryRaw<EventRow[]>`
        SELECT v.id::text AS id, v."paymentId", (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "amountCents",
               v."occurredAt", v.payload
          FROM payment_events v
          JOIN payments p ON p.id = v."paymentId"
         WHERE v."tenantId" = ${tenantId}::uuid
           AND v."eventType" = 'pos.voided'
           AND v."occurredAt" >= ${since}
           AND p.status::text IN ('AUTHORIZED', 'PARTIALLY_REFUNDED')
           AND p."posOperationNumber" = v.payload ->> 'operationNumber'
           AND p."posTerminalId"::text = v.payload ->> 'terminalId'
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = v."tenantId" AND k.kind = 'pos_voided_paid'
                              AND k."refId" = v.id::text)
         ORDER BY v."occurredAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // Ventas por datáfono sin prueba del banco, una incidencia por noche:
      // las del PAX sin la consulta de Paytef y las que confirma un camarero
      // tecleando el ticket. Su comisión está retenida (bank-hold-sql) y se
      // quitan al cuadrarlas con el banco o al liberarlas el dueño.
      () => this.prisma.$queryRaw<UnprovenSalesRow[]>`
        SELECT to_char(((x.at AT TIME ZONE 'Europe/Madrid') - interval '8 hours')::date, 'YYYY-MM-DD') AS night,
               COUNT(*)::int AS count, SUM(x.cents)::int AS "amountCents", MAX(x.at) AS "lastAt"
          FROM (
            SELECT DISTINCT ON (p.id) p.id, e."occurredAt" AS at, (p."amountCents" + p."serviceFeeCents" + p."tipCents") AS cents
              FROM payment_events e
              JOIN payments p ON p.id = e."paymentId"
             WHERE e."tenantId" = ${tenantId}::uuid
               AND e."eventType" IN ('pos.device_unproven', 'pos.confirmed')
               AND e."occurredAt" >= ${since}
               AND p.status::text IN ('AUTHORIZED', 'PARTIALLY_REFUNDED')
               AND ${paymentBankHeldSql('p')}
             ORDER BY p.id, e."occurredAt"
          ) x
         GROUP BY 1
         ORDER BY 1 DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // Recargas cobradas sin el NFC del cliente que siguen sin su saldo (tras
      // unos minutos: lo normal es asignarla al momento). FORCE RLS: con bypass.
      () => this.prisma.asSystem((tx) => tx.$queryRaw<PendingTopUpRow[]>`
        SELECT id, "balanceCents", "pendingAssignAt" AS "occurredAt"
          FROM client_wallets
         WHERE "tenantId" = ${tenantId}::uuid
           AND "pendingAssignAt" IS NOT NULL
           AND "pendingAssignAt" < ${unassignedBefore}
           AND "mergedIntoId" IS NULL
           AND status = 'ACTIVE'
           AND "balanceCents" > 0
         ORDER BY "pendingAssignAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `),
    ] as const, INCIDENT_QUERY_CONCURRENCY);

    const all: Incident[] = [
      ...stuck.map(stuckIncident),
      ...duplicates.map(duplicateChargeIncident),
      ...auditRows.map((r) =>
        r.action === 'refund.earning_reverse_failed'
          ? earningReverseFailedIncident(r)
          : r.action === 'pos.reception_limit_exceeded'
            ? posReceptionLimitIncident(r)
            : r.action === 'wallet.cash_split_suspected'
              ? cashSplitIncident(r)
              : r.action === 'wallet.reception_payout_cap'
                ? receptionPayoutCapIncident(r)
                : r.action === 'wallet.card_blocked_by_client'
                  ? walletCardLostIncident(r)
                  : SENSITIVE_AUDIT_ACTIONS.includes(r.action)
                    ? sensitiveActionIncident(r)
                    : walletCreditSkippedIncident(r),
      ),
      ...unprovenSales.map(posUnprovenSalesIncident),
      ...nights.map(nightClosedPendingIncident),
      ...posMismatches.map(posChargeMismatchIncident),
      ...posUnmatched.map(posUnmatchedOpIncident),
      ...posUnreconciled.map(posUnreconciledIncident),
      ...posVoidedPaid.map(posVoidedPaidIncident),
      ...walletsToClose.map(walletCloseRequestedIncident),
      ...walletsLeftOpen.map(walletOpenBalanceIncident),
      ...unassignedTopUps.map(walletTopUpUnassignedIncident),
      // La misma diferencia repetida (dos subidas a la vez) sale una vez.
      ...uniqueBy(bankItems.map(bankMismatchIncident), (i) => i.refId),
      // "Sin comprobar" va por cobro: varios avisos del mismo cobro, uno solo.
      ...uniqueBy(anomalies.map(paymentAnomalyIncident), (i) => `${i.kind}:${i.refId}`),
      ...pendingRefunds.map((r) => refundPendingIncident(r, now)),
      ...pendingApprovals.map((r) => approvalPendingIncident(r, now)),
      ...(this.backups
        ? backupIncidents(await this.backups.verdict(now), now, process.env.NODE_ENV === 'production')
        : []),
    ];
    const open = openIncidents(all, new Set(acks.map((a) => ackKey(a.kind, a.refId))));
    // Los de dinero se cierran escribiendo qué se hizo (B11).
    return open.map((i) => ({ ...i, noteRequired: i.ackable && ackNeedsNote(i) }));
  }

  /** El dueño la revisó: se quita de la bandeja (queda en el registro). */
  async ack(
    tenantId: string,
    actorId: string,
    input: { kind: IncidentKind; refId: string; note?: string },
  ): Promise<void> {
    if (SELF_RESOLVING.has(input.kind)) {
      throw new BadRequestException('Este aviso se quita solo al resolver el cobro en Hoy → Cobros');
    }
    const current = await this.list(tenantId);
    const found = current.find((i) => i.kind === input.kind && i.refId === input.refId);
    if (!found) {
      throw new NotFoundException('Esa incidencia no está en la bandeja de este local');
    }
    // Aviso de dinero (B11): se cierra diciendo qué se hizo.
    if (ackNeedsNote(found) && (input.note?.trim().length ?? 0) < MIN_ACK_NOTE_LENGTH) {
      throw new BadRequestException({
        message: 'Es un aviso de dinero: escribe qué has hecho para cerrarlo.',
        code: 'INCIDENT_NOTE_REQUIRED',
      });
    }
    await this.prisma.incidentAck.upsert({
      where: { tenantId_kind_refId: { tenantId, kind: input.kind, refId: input.refId } },
      create: { tenantId, kind: input.kind, refId: input.refId, ackedBy: actorId, note: input.note ?? null },
      update: {},
    });
    await this.audit.log({
      action: 'incident.acked',
      tenantId,
      actorId,
      targetType: 'Incident',
      targetId: `${input.kind}:${input.refId}`,
      payload: { note: input.note ?? null },
    });
  }
}

function uniqueBy<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
