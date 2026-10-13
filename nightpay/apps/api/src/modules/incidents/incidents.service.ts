import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  SELF_RESOLVING,
  ackKey,
  duplicateChargeIncident,
  earningReverseFailedIncident,
  nightClosedPendingIncident,
  openIncidents,
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

/**
 * Bandeja de incidencias (Fase 1E). Se calcula al vuelo para un local;
 * SQL crudo con el local explícito (también la usan las alertas, fuera de
 * una petición).
 */
@Injectable()
export class IncidentsService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  async list(tenantId: string, now: Date = new Date()): Promise<Incident[]> {
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const stuckBefore = new Date(now.getTime() - STUCK_MINUTES * 60 * 1000);
    const [stuck, duplicates, auditRows, nights, acks] = await Promise.all([
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
    ]);

    const all: Incident[] = [
      ...stuck.map(stuckIncident),
      ...duplicates.map(duplicateChargeIncident),
      ...auditRows.map((r) =>
        r.action === 'refund.earning_reverse_failed' ? earningReverseFailedIncident(r) : walletCreditSkippedIncident(r),
      ),
      ...nights.map(nightClosedPendingIncident),
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
