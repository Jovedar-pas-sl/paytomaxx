import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CobroRow, DevolucionRow, LiquidacionRow } from './export-rows';
import type { TimeWindow } from './report-period';

/** Tope de filas por informe: un local con mucho movimiento hace ~10k cobros al mes. */
export const MAX_EXPORT_ROWS = 100_000;

/**
 * Lecturas del informe para la gestoría (Fase 1C). SQL crudo con el local
 * explícito (`tenantId`): varias tablas unidas y sin pasar por el middleware.
 */
@Injectable()
export class ReportsService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  async venueName(tenantId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({ where: { id: tenantId }, select: { name: true } });
    return venue?.name ?? '';
  }

  /** Cobros pagados en el periodo (fecha = autorización del banco). */
  async cobros(tenantId: string, p: TimeWindow): Promise<CobroRow[]> {
    return capped(await this.prisma.$queryRaw<CobroRow[]>`
      SELECT p.id,
             COALESCE(p."authorizedAt", p."createdAt") AS "paidAt",
             p.status::text AS status,
             p."amountCents",
             p."tipCents",
             p."revenueCategory",
             p."captureMethod",
             p."serviceName",
             a."payMethod",
             p."payMethodCode",
             p."cardBrand",
             p."cardType",
             p."cardCountry",
             p."authCode",
             p."providerTxId",
             p."walletId",
             u."displayName" AS "creatorName",
             u.email AS "creatorEmail",
             eu."displayName" AS "earningOperatorName",
             eu.email AS "earningOperatorEmail",
             COALESCE(r.refunded, 0)::int AS "refundedCents",
             e."commissionCents",
             e."tipCents" AS "earningTipCents",
             e."reversedCents"
        FROM payments p
        LEFT JOIN users u ON u.id = p."createdByUserId"
        LEFT JOIN operator_earnings e ON e."paymentId" = p.id
        LEFT JOIN users eu ON eu.id = e."operatorId"
        LEFT JOIN LATERAL (
          SELECT SUM(rf."amountCents") AS refunded
            FROM refunds rf
           WHERE rf."paymentId" = p.id AND rf.status = 'SUCCEEDED'
        ) r ON true
        LEFT JOIN LATERAL (
          SELECT pa."payMethod"
            FROM payment_attempts pa
           WHERE pa."paymentId" = p.id AND pa.status = 'APPROVED'
           ORDER BY pa."createdAt" ASC
           LIMIT 1
        ) a ON true
       WHERE p."tenantId" = ${tenantId}::uuid
         AND p.status IN ('AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED')
         AND COALESCE(p."authorizedAt", p."createdAt") >= ${p.from}
         AND COALESCE(p."authorizedAt", p."createdAt") < ${p.to}
       ORDER BY "paidAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `);
  }

  /** Devoluciones hechas en el periodo (fecha = día de la devolución en el banco). */
  async devoluciones(tenantId: string, p: TimeWindow): Promise<DevolucionRow[]> {
    return capped(await this.prisma.$queryRaw<DevolucionRow[]>`
      SELECT r.id,
             COALESCE(r."bankRefundedAt", r."createdAt") AS "refundedAt",
             r."amountCents",
             r.reason,
             r."providerRefundId",
             r."registeredManually",
             ru."displayName" AS "byName",
             ru.email AS "byEmail",
             p.id AS "paymentId",
             COALESCE(p."authorizedAt", p."createdAt") AS "paidAt",
             p."providerTxId",
             (p."amountCents" + p."tipCents")::int AS "chargedCents",
             cu."displayName" AS "creatorName",
             cu.email AS "creatorEmail",
             eu."displayName" AS "chicaName",
             eu.email AS "chicaEmail",
             er."reversedDeltaCents",
             er."afterPayout"
        FROM refunds r
        JOIN payments p ON p.id = r."paymentId"
        LEFT JOIN users ru ON ru.id = r."requestedBy"
        LEFT JOIN users cu ON cu.id = p."createdByUserId"
        LEFT JOIN earning_reversals er ON er."refundId" = r.id
        LEFT JOIN operator_earnings ee ON ee.id = er."earningId"
        LEFT JOIN users eu ON eu.id = ee."operatorId"
       WHERE r."tenantId" = ${tenantId}::uuid
         AND r.status = 'SUCCEEDED'
         AND COALESCE(r."bankRefundedAt", r."createdAt") >= ${p.from}
         AND COALESCE(r."bankRefundedAt", r."createdAt") < ${p.to}
       ORDER BY "refundedAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `);
  }

  /** Pagos a chicas hechos en el periodo. */
  async liquidaciones(tenantId: string, p: TimeWindow): Promise<LiquidacionRow[]> {
    return capped(await this.prisma.$queryRaw<LiquidacionRow[]>`
      SELECT po.id,
             po."createdAt" AS "paidAt",
             po."totalCents",
             po."externalRail",
             po."externalTxId",
             po."reconciliationStatus",
             po.notes,
             u."displayName" AS "operatorName",
             u.email AS "operatorEmail",
             pb."displayName" AS "paidByName",
             pb.email AS "paidByEmail",
             (SELECT COUNT(*) FROM operator_earnings e WHERE e."payoutId" = po.id)::int AS "earningCount"
        FROM operator_payouts po
        JOIN users u ON u.id = po."operatorId"
        LEFT JOIN users pb ON pb.id = po."paidByUserId"
       WHERE po."tenantId" = ${tenantId}::uuid
         AND po."createdAt" >= ${p.from}
         AND po."createdAt" < ${p.to}
       ORDER BY po."createdAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `);
  }
}

/** Un informe recortado parecería completo: mejor pedir un periodo más corto. */
function capped<T>(rows: T[]): T[] {
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new BadRequestException('Demasiadas filas para un solo archivo: elige un periodo más corto');
  }
  return rows;
}
