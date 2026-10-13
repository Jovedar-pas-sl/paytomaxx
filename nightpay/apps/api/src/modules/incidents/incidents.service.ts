import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lastNightCutoff } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { BackupMonitorService } from '../db-backups/backup-monitor.service';
import {
  SELF_RESOLVING,
  ackKey,
  duplicateChargeIncident,
  earningReverseFailedIncident,
  nightClosedPendingIncident,
  openIncidents,
  posChargeMismatchIncident,
  posUnmatchedOpIncident,
  posUnreconciledIncident,
  walletCloseRequestedIncident,
  walletOpenBalanceIncident,
  bankMismatchIncident,
  backupIncidents,
  type BankItemRow,
  type WalletBalanceRow,
  stuckIncident,
  walletCreditSkippedIncident,
  type EventRow,
  type Incident,
  type IncidentKind,
  type NightPendingRow,
  type StuckRow,
} from './incident-rules';

/** Hasta dónde se mira atrás, y cuántas de cada tipo como mucho. */
const LOOKBACK_DAYS = 60;
const PER_KIND_LIMIT = 100;
/** Un cobro esperando al banco más de esto se da por atascado (como en Pagos → Resolver). */
const STUCK_MINUTES = 15;
/** Un cobro del datáfono debería salir en un cuadre de ese datáfono en este tiempo. */
const RECONCILE_WITHIN_HOURS = 24;

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
    const nightStart = lastNightCutoff(now);
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
    ] = await Promise.all([
      this.prisma.$queryRaw<StuckRow[]>`
        SELECT id, status::text AS status, "amountCents", "updatedAt"
          FROM payments
         WHERE "tenantId" = ${tenantId}::uuid
           AND "createdAt" >= ${since}
           AND (status = 'ORPHAN'
                OR (status = 'AUTHORIZING' AND "updatedAt" < ${stuckBefore}))
         ORDER BY "updatedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      this.prisma.$queryRaw<EventRow[]>`
        SELECT e.id::text AS id, e."paymentId", (p."amountCents" + p."tipCents")::int AS "amountCents",
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
      this.prisma.$queryRaw<Array<EventRow & { action: string }>>`
        SELECT a.id::text AS id, a.action, a."targetId" AS "paymentId",
               CASE WHEN jsonb_typeof(a.payload -> 'amountCents') = 'number'
                    THEN (a.payload ->> 'amountCents')::int END AS "amountCents",
               a."occurredAt", a.payload
          FROM audit_events a
         WHERE a."tenantId" = ${tenantId}::uuid
           AND a.action IN ('refund.earning_reverse_failed', 'wallet.credit_skipped_critical')
           AND NOT EXISTS (SELECT 1 FROM incident_acks k
                            WHERE k."tenantId" = a."tenantId"
                              AND k.kind IN ('earning_reverse_failed', 'wallet_credit_skipped')
                              AND k."refId" = a.id::text)
           AND a."occurredAt" >= ${since}
         ORDER BY a."occurredAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      this.prisma.$queryRaw<NightPendingRow[]>`
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
      this.prisma.$queryRaw<Array<{ kind: string; refId: string }>>`
        SELECT kind, "refId" FROM incident_acks WHERE "tenantId" = ${tenantId}::uuid
      `,
      this.prisma.$queryRaw<EventRow[]>`
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
      this.prisma.$queryRaw<EventRow[]>`
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
      this.prisma.$queryRaw<EventRow[]>`
        SELECT p.id::text AS id, p.id AS "paymentId", (p."amountCents" + p."tipCents")::int AS "amountCents",
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
                                   OR o."amountCents" = p."amountCents" + p."tipCents"))
         ORDER BY p."authorizedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `,
      // client_wallets tiene FORCE RLS: se lee con bypass y se filtra por local aquí.
      this.prisma.asSystem((tx) => tx.$queryRaw<WalletBalanceRow[]>`
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
      this.prisma.asSystem((tx) => tx.$queryRaw<WalletBalanceRow[]>`
        SELECT id, "shortCode", "balanceCents", "updatedAt" AS "occurredAt"
          FROM client_wallets
         WHERE "tenantId" = ${tenantId}::uuid
           AND status = 'ACTIVE'
           AND "balanceCents" > 0
           AND "closeRequestedAt" IS NULL
           AND "updatedAt" < ${nightStart}
           AND "updatedAt" >= ${since}
         ORDER BY "updatedAt" DESC
         LIMIT ${PER_KIND_LIMIT}
      `),
      // Cuadre con el banco: lo que no cuadra (si un fichero posterior cubre
      // ese día, deja de contar; "cobrado y aquí sin pagar" se quita al resolverlo).
      this.prisma.$queryRaw<BankItemRow[]>`
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
    ]);

    const all: Incident[] = [
      ...stuck.map(stuckIncident),
      ...duplicates.map(duplicateChargeIncident),
      ...auditRows.map((r) =>
        r.action === 'refund.earning_reverse_failed' ? earningReverseFailedIncident(r) : walletCreditSkippedIncident(r),
      ),
      ...nights.map(nightClosedPendingIncident),
      ...posMismatches.map(posChargeMismatchIncident),
      ...posUnmatched.map(posUnmatchedOpIncident),
      ...posUnreconciled.map(posUnreconciledIncident),
      ...walletsToClose.map(walletCloseRequestedIncident),
      ...walletsLeftOpen.map(walletOpenBalanceIncident),
      // La misma diferencia repetida (dos subidas a la vez) sale una vez.
      ...uniqueBy(bankItems.map(bankMismatchIncident), (i) => i.refId),
      ...(this.backups
        ? backupIncidents(await this.backups.verdict(now), now, process.env.NODE_ENV === 'production')
        : []),
    ];
    return openIncidents(all, new Set(acks.map((a) => ackKey(a.kind, a.refId))));
  }

  /** El dueño la revisó: se quita de la bandeja (queda en el registro). */
  async ack(
    tenantId: string,
    actorId: string,
    input: { kind: IncidentKind; refId: string; note?: string },
  ): Promise<void> {
    if (SELF_RESOLVING.has(input.kind)) {
      throw new BadRequestException('Este aviso se quita solo al resolver el cobro en Pagos');
    }
    const current = await this.list(tenantId);
    if (!current.some((i) => i.kind === input.kind && i.refId === input.refId)) {
      throw new NotFoundException('Esa incidencia no está en la bandeja de este local');
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
