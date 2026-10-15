import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AdjustmentRows, CobroRow, ConsumoRow, DevolucionRow, LiquidacionRow, PagoSaldoRow } from './export-rows';
import type { TimeWindow } from './report-period';
import {
  PAID_EVENTS_SQL,
  PAID_STATUSES_SQL,
  afterPayoutDebt,
  paymentAt,
  paymentRecordedAt,
  refundAt,
} from './reporting-sql';

/** Tope de filas por informe: un local con mucho movimiento hace ~10k cobros al mes. */
export const MAX_EXPORT_ROWS = 100_000;

/**
 * Para el Z de una noche: el informe tal como estaba al generarlo. Lo que se
 * apunte después con fecha de esa noche sale en el Z siguiente, como ajuste
 * (ajustes()). Sin esto, el informe es «tal como está ahora».
 */
export interface AsOf {
  /**
   * Solo cobros pagados y devoluciones apuntados antes de este instante; los
   * consumos anulados después aún cuentan (su anulación es un ajuste).
   */
  recordedBefore?: Date;
}

/** Ajustes de noches anteriores: lo apuntado en [since, until) con fecha anterior a `before`. */
export interface AdjustmentWindow {
  before: Date;
  since: Date;
  until: Date;
}

/**
 * Lecturas del informe para la gestoría (Fase 1C) y del Z de las noches. SQL
 * crudo con el local explícito (`tenantId`): varias tablas unidas y sin pasar
 * por el middleware. Fechas y filtros: reporting-sql.ts.
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
  async cobros(tenantId: string, p: TimeWindow, asOf: AsOf = {}): Promise<CobroRow[]> {
    const recorded = asOf.recordedBefore
      ? Prisma.sql`AND ${paymentRecordedAt('p')} < ${asOf.recordedBefore}`
      : Prisma.empty;
    return capped(
      await this.cobrosWhere(tenantId, Prisma.sql`${paymentAt('p')} >= ${p.from} AND ${paymentAt('p')} < ${p.to} ${recorded}`),
    );
  }

  /** Consumos del saldo hechos en este local, por fecha del consumo (sin los anulados). */
  async consumos(tenantId: string, p: TimeWindow, asOf: AsOf = {}): Promise<ConsumoRow[]> {
    // Para un Z: los anulados después de generarlo aún contaban (su anulación es un ajuste del siguiente).
    const active = asOf.recordedBefore
      ? Prisma.sql`(c."reversedAt" IS NULL OR c."reversedAt" >= ${asOf.recordedBefore})`
      : Prisma.sql`c."reversedAt" IS NULL`;
    return capped(
      await this.consumosWhere(tenantId, Prisma.sql`${active} AND c."createdAt" >= ${p.from} AND c."createdAt" < ${p.to}`),
    );
  }

  /** Devoluciones hechas en el periodo (fecha = día de la devolución en el banco). */
  async devoluciones(tenantId: string, p: TimeWindow, asOf: AsOf = {}): Promise<DevolucionRow[]> {
    const recorded = asOf.recordedBefore ? Prisma.sql`AND r."createdAt" < ${asOf.recordedBefore}` : Prisma.empty;
    return capped(
      await this.devolucionesWhere(tenantId, Prisma.sql`${refundAt('r')} >= ${p.from} AND ${refundAt('r')} < ${p.to} ${recorded}`),
    );
  }

  /**
   * Lo apuntado desde el Z anterior con fecha de una noche ya cerrada: su Z
   * está congelado, así que va al Z siguiente como ajuste (nunca en ninguno,
   * si no). Cobros por la hora en que quedaron pagados aquí (payment_events);
   * devoluciones por cuándo se apuntaron; consumos por cuándo se anularon.
   */
  async ajustes(tenantId: string, a: AdjustmentWindow): Promise<AdjustmentRows> {
    const [cobros, devoluciones, consumosAnulados] = await Promise.all([
      this.cobrosWhere(
        tenantId,
        Prisma.sql`p.id IN (
            SELECT pe."paymentId" FROM payment_events pe
             WHERE pe."tenantId" = ${tenantId}::uuid AND pe."eventType" IN ${PAID_EVENTS_SQL}
               AND pe."occurredAt" >= ${a.since} AND pe."occurredAt" < ${a.until}
          )
          AND ${paymentRecordedAt('p')} >= ${a.since}
          AND ${paymentAt('p')} < ${a.before}`,
      ),
      this.devolucionesWhere(
        tenantId,
        Prisma.sql`r."createdAt" >= ${a.since} AND r."createdAt" < ${a.until} AND ${refundAt('r')} < ${a.before}`,
      ),
      this.consumosWhere(
        tenantId,
        Prisma.sql`c."reversedAt" >= ${a.since} AND c."reversedAt" < ${a.until} AND c."createdAt" < ${a.before}`,
      ),
    ]);
    return { cobros: capped(cobros), devoluciones: capped(devoluciones), consumosAnulados: capped(consumosAnulados) };
  }

  /**
   * Saldo devuelto a los clientes en este local en el periodo. El de efectivo
   * solo está aquí; el de tarjeta, además, como devoluciones de las recargas.
   */
  async pagosSaldo(tenantId: string, p: TimeWindow): Promise<PagoSaldoRow[]> {
    // TODO(merge): con fix/rev-wallets, AND wp."status" = 'DONE' (una devolución a la
    // tarjeta queda PENDING hasta completarse).
    return capped(await this.prisma.$queryRaw<PagoSaldoRow[]>`
      SELECT wp.id,
             wp."createdAt" AS "at",
             wp."amountCents",
             wp.method,
             pb."displayName" AS "paidByName",
             pb.email AS "paidByEmail"
        FROM wallet_payouts wp
        LEFT JOIN users pb ON pb.id = wp."paidByUserId"
       WHERE wp."tenantId" = ${tenantId}::uuid
         AND wp."createdAt" >= ${p.from}
         AND wp."createdAt" < ${p.to}
       ORDER BY wp."createdAt" ASC
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

  /** Cobros pagados del local que cumplen `where` (alias p). */
  private cobrosWhere(tenantId: string, where: Prisma.Sql): Promise<CobroRow[]> {
    return this.prisma.$queryRaw<CobroRow[]>`
      SELECT p.id,
             ${paymentAt('p')} AS "paidAt",
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
             e."reversedCents",
             ${afterPayoutDebt('e')}::int AS "reversedAfterPayoutCents"
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
         AND p.status IN ${PAID_STATUSES_SQL}
         AND ${where}
       ORDER BY "paidAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `;
  }

  /** Consumos del saldo del local que cumplen `where` (alias c), con la parte de la chica si la hay. */
  private consumosWhere(tenantId: string, where: Prisma.Sql): Promise<ConsumoRow[]> {
    return this.prisma.$queryRaw<ConsumoRow[]>`
      SELECT c.id,
             c."createdAt" AS "at",
             c."amountCents",
             c."tipCents",
             c.category,
             u."displayName" AS "operatorName",
             u.email AS "operatorEmail",
             e."commissionCents",
             e."tipCents" AS "earningTipCents"
        FROM wallet_consumptions c
        LEFT JOIN operator_earnings e ON e."consumptionId" = c.id
        LEFT JOIN users u ON u.id = e."operatorId"
       WHERE c."tenantId" = ${tenantId}::uuid
         AND ${where}
       ORDER BY c."createdAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `;
  }

  /** Devoluciones hechas del local que cumplen `where` (alias r), con lo descontado a la chica. */
  private devolucionesWhere(tenantId: string, where: Prisma.Sql): Promise<DevolucionRow[]> {
    return this.prisma.$queryRaw<DevolucionRow[]>`
      SELECT r.id,
             ${refundAt('r')} AS "refundedAt",
             r."amountCents",
             r.reason,
             r."providerRefundId",
             r."registeredManually",
             ru."displayName" AS "byName",
             ru.email AS "byEmail",
             p.id AS "paymentId",
             ${paymentAt('p')} AS "paidAt",
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
         AND ${where}
       ORDER BY "refundedAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `;
  }
}

/** Un informe recortado parecería completo: mejor pedir un periodo más corto. */
function capped<T>(rows: T[]): T[] {
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new BadRequestException('Demasiadas filas para un solo archivo: elige un periodo más corto');
  }
  return rows;
}
