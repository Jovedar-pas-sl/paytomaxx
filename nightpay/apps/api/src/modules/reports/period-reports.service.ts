import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LATE_CARD_APPROVAL_EVENTS } from '../payments/late-card-approval';
import { buildMetrics, buildPeriodZ, type ZCategoryRow, type ZGroupRow, type ZOperatorRow } from './period-reports';
import { totalsFromRow, type PeriodTotals, type PeriodTotalsRow } from './period-totals';
import type { TimeWindow } from './report-period';
import { PAID_STATUSES_SQL, afterPayoutDebt, cashTopUpCount, paymentAt, refundAt, refundTipPart } from './reporting-sql';
import { madridQuarter, madridRecentDaysWindow, madridTodayWindow } from './reporting-window';
import { buildVat303, vatExempt } from './vat-303';

/** La semana de las métricas: hoy y los 7 días anteriores (como antes). */
const METRICS_PAST_DAYS = 7;

type Count = { count: number | bigint | null };

/**
 * Métricas del panel, Z de un periodo e IVA 303 (antes en AdminController).
 * Agregados en SQL con el local explícito y las reglas de reporting-sql.ts:
 * las mismas fechas y filtros que el informe de la gestoría y las noches.
 */
@Injectable()
export class PeriodReportsService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /** Hoy y la semana (días de Madrid). El panel lo pide cada pocos segundos: pocas consultas. */
  async metrics(tenantId: string, now: Date = new Date()) {
    const today = madridTodayWindow(now);
    const [todayTotals, weekTotals, statuses] = await Promise.all([
      this.totals(tenantId, today),
      this.totals(tenantId, madridRecentDaysWindow(now, METRICS_PAST_DAYS)),
      this.statusCounts(tenantId, today),
    ]);
    return buildMetrics({ today: todayTotals, week: weekTotals, statuses });
  }

  /** Z (cierre de caja) de un periodo cualquiera. */
  async periodZ(tenantId: string, window: TimeWindow, now: Date = new Date()) {
    const [totals, groups, categories, operators, payouts] = await Promise.all([
      this.totals(tenantId, window),
      this.groups(tenantId, window),
      this.categories(tenantId, window),
      this.operators(tenantId, window),
      this.operatorPayouts(tenantId, window),
    ]);
    const operatorPayouts = payouts[0] ?? { count: 0, totalCents: 0 };
    return buildPeriodZ({ window, totals, groups, categories, operators, operatorPayouts, now });
  }

  /** Modelo 303 del trimestre (o del actual): suma de sus tres meses de Madrid. */
  async vat303(tenantId: string, quarterLabel: string | undefined, now: Date = new Date()) {
    const quarter = madridQuarter(quarterLabel, now);
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, vatBps: true, vatRegime: true },
    });
    if (venue.vatRegime === 'EXENTO') return vatExempt(quarter, venue);
    const [months, consumptions] = await Promise.all([
      Promise.all(quarter.months.map((m) => this.totals(tenantId, m))),
      this.consumptionTotals(tenantId, quarter),
    ]);
    return buildVat303({ quarter, venue, months, consumptions, now });
  }

  /** Cobros, devoluciones y saldo devuelto del periodo, en una sola consulta. */
  async totals(tenantId: string, w: TimeWindow): Promise<PeriodTotals> {
    // La CTE «saldo» cuenta solo las devoluciones hechas (status DONE): una a la
    // tarjeta queda PENDING hasta completarse.
    // En withTenant: wallet_cash_topups tiene FORCE RLS.
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<PeriodTotalsRow[]>`
      WITH cobros AS (
        SELECT COUNT(*)::int AS "paymentCount",
               COALESCE(SUM(p."amountCents"), 0)::bigint AS "grossCents",
               COALESCE(SUM(p."tipCents"), 0)::bigint AS "tipCents",
               COUNT(*) FILTER (WHERE p."walletId" IS NOT NULL)::int AS "walletCardTopUpCount",
               COALESCE(SUM(p."amountCents") FILTER (WHERE p."walletId" IS NOT NULL), 0)::bigint AS "walletCardTopUpCents"
          FROM payments p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p.status IN ${PAID_STATUSES_SQL}
           AND ${paymentAt('p')} >= ${w.from} AND ${paymentAt('p')} < ${w.to}
      ), devoluciones AS (
        SELECT COUNT(*)::int AS "refundCount",
               COALESCE(SUM(r."amountCents"), 0)::bigint AS "refundedCents",
               COALESCE(SUM(${refundTipPart('r', 'p')}), 0)::bigint AS "refundedTipCents"
          FROM refunds r
          JOIN payments p ON p.id = r."paymentId"
         WHERE r."tenantId" = ${tenantId}::uuid
           AND r.status = 'SUCCEEDED'
           AND ${refundAt('r')} >= ${w.from} AND ${refundAt('r')} < ${w.to}
      ), saldo AS (
        SELECT COUNT(*) FILTER (WHERE wp.method = 'CASH')::int AS "walletCashPayoutCount",
               COALESCE(SUM(wp."amountCents") FILTER (WHERE wp.method = 'CASH'), 0)::bigint AS "walletCashPayoutCents",
               COUNT(*) FILTER (WHERE wp.method = 'CARD')::int AS "walletCardPayoutCount",
               COALESCE(SUM(wp."amountCents") FILTER (WHERE wp.method = 'CARD'), 0)::bigint AS "walletCardPayoutCents"
          FROM wallet_payouts wp
         WHERE wp."tenantId" = ${tenantId}::uuid
           AND wp."status" = 'DONE'
           AND wp."createdAt" >= ${w.from} AND wp."createdAt" < ${w.to}
      ), efectivo AS (
        SELECT ${cashTopUpCount('ct')}::int AS "walletCashTopUpCount",
               COALESCE(SUM(ct."amountCents"), 0)::bigint AS "walletCashTopUpCents"
          FROM wallet_cash_topups ct
         WHERE ct."tenantId" = ${tenantId}::uuid
           AND ct."createdAt" >= ${w.from} AND ct."createdAt" < ${w.to}
      )
      SELECT * FROM cobros, devoluciones, saldo, efectivo
    `);
    return totalsFromRow(rows[0]);
  }

  /**
   * Cobros por estado (también los no pagados: fallidos, caducados…). Sin el
   * cobro con tarjeta que canceló el saldo al pagarlo (cobro único): ese cobro
   * es el del saldo (como en la lista de Cobros, cobros.service NOT_SALDO_TWIN).
   */
  private async statusCounts(tenantId: string, w: TimeWindow): Promise<Array<{ status: string; count: number }>> {
    return this.prisma.$queryRaw<Array<{ status: string; count: number }>>`
      SELECT p.status::text AS status, COUNT(*)::int AS count
        FROM payments p
       WHERE p."tenantId" = ${tenantId}::uuid
         AND ${paymentAt('p')} >= ${w.from} AND ${paymentAt('p')} < ${w.to}
         AND NOT (p.status = 'CANCELED'
                  AND EXISTS (SELECT 1 FROM wallet_charge_requests w
                               WHERE w."linkedPaymentId" = p.id AND w.status = 'ACCEPTED')
                  AND NOT EXISTS (SELECT 1 FROM payment_events e
                                   WHERE e."paymentId" = p.id
                                     AND e."eventType" IN (${Prisma.join(LATE_CARD_APPROVAL_EVENTS)})))
       GROUP BY p.status
    `;
  }

  private async groups(tenantId: string, w: TimeWindow): Promise<ZGroupRow[]> {
    return this.prisma.$queryRaw<ZGroupRow[]>`
      SELECT p."captureMethod", p.provider::text AS provider, t.zone,
             COUNT(*)::int AS count,
             COALESCE(SUM(p."amountCents"), 0)::bigint AS "grossCents",
             COALESCE(SUM(p."tipCents"), 0)::bigint AS "tipCents"
        FROM payments p
        LEFT JOIN terminals t ON t.id = p."terminalId"
       WHERE p."tenantId" = ${tenantId}::uuid
         AND p.status IN ${PAID_STATUSES_SQL}
         AND ${paymentAt('p')} >= ${w.from} AND ${paymentAt('p')} < ${w.to}
       GROUP BY p."captureMethod", p.provider, t.zone
    `;
  }

  /**
   * Cobros (aparte las recargas, con tarjeta y en efectivo) y consumos del
   * saldo, por tipo y POR LÍNEA (payment_lines, 24-oct-2026): cada sección con
   * lo suyo; lo que no cubren las líneas (todo, en los cobros de antes) y la
   * propina, en su sección principal. Un cobro con varias secciones cuenta en
   * cada una; uno de una sola sección, igual que antes.
   */
  private async categories(tenantId: string, w: TimeWindow): Promise<ZCategoryRow[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<ZCategoryRow[]>`
      WITH paid AS (
        SELECT p.id, p."amountCents", p."tipCents", p."revenueCategory", p."walletId"
          FROM payments p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p.status IN ${PAID_STATUSES_SQL}
           AND ${paymentAt('p')} >= ${w.from} AND ${paymentAt('p')} < ${w.to}
      ), consumed AS (
        SELECT c.id, c."amountCents", c."tipCents", c.category
          FROM wallet_consumptions c
         WHERE c."tenantId" = ${tenantId}::uuid
           AND c."reversedAt" IS NULL
           AND c."createdAt" >= ${w.from} AND c."createdAt" < ${w.to}
      ), sale_lines AS (
        SELECT 'CARD' AS source, l."paymentId" AS sale, l.category, l."amountCents"
          FROM payment_lines l JOIN paid ON paid.id = l."paymentId"
         WHERE paid."walletId" IS NULL
        UNION ALL
        SELECT 'WALLET', consumed.id, l.category, l."amountCents"
          FROM consumed
          JOIN wallet_charge_requests wr ON wr."consumptionId" = consumed.id
          JOIN payment_lines l ON l."walletChargeId" = wr.id
      ), sales AS (
        SELECT 'CARD' AS source, id AS sale, "revenueCategory" AS category, "amountCents", "tipCents"
          FROM paid WHERE "walletId" IS NULL
        UNION ALL
        SELECT 'WALLET', id, category, "amountCents", "tipCents" FROM consumed
      ), parts AS (
        SELECT source, sale, category, SUM("amountCents")::bigint AS gross, 0::bigint AS tip, true AS counts
          FROM sale_lines GROUP BY 1, 2, 3
        UNION ALL
        SELECT s.source, s.sale, s.category,
               (s."amountCents" - COALESCE(SUM(sl."amountCents"), 0))::bigint,
               s."tipCents"::bigint,
               COUNT(sl.sale) = 0
          FROM sales s
          LEFT JOIN sale_lines sl ON sl.source = s.source AND sl.sale = s.sale
         GROUP BY s.source, s.sale, s.category, s."amountCents", s."tipCents"
      ), per_sale AS (
        SELECT source, sale, category, SUM(gross) AS gross, SUM(tip) AS tip
          FROM parts
         WHERE counts OR gross <> 0 OR tip <> 0
         GROUP BY 1, 2, 3
      )
      SELECT source, category,
             COUNT(*)::int AS count,
             COALESCE(SUM(gross), 0)::bigint AS "grossCents",
             COALESCE(SUM(tip), 0)::bigint AS "tipCents"
        FROM per_sale
       GROUP BY 1, 2
      UNION ALL
      SELECT 'TOPUP' AS source, "revenueCategory" AS category,
             COUNT(*)::int AS count,
             COALESCE(SUM("amountCents"), 0)::bigint AS "grossCents",
             COALESCE(SUM("tipCents"), 0)::bigint AS "tipCents"
        FROM paid
       WHERE "walletId" IS NOT NULL
       GROUP BY 2
      UNION ALL
      SELECT 'TOPUP' AS source, 'EXTRA' AS category,
             ${cashTopUpCount('ct')}::int AS count,
             COALESCE(SUM(ct."amountCents"), 0)::bigint AS "grossCents",
             0::bigint AS "tipCents"
        FROM wallet_cash_topups ct
       WHERE ct."tenantId" = ${tenantId}::uuid
         AND ct."createdAt" >= ${w.from} AND ct."createdAt" < ${w.to}
      HAVING COUNT(*) > 0
    `);
  }

  /**
   * Parte de cada chica de lo cobrado en el periodo (con tarjeta o del saldo):
   * comisión + propina − lo descontado, también la deuda de devoluciones
   * llegadas después de pagarle (como la columna «Parte chica» del CSV).
   */
  private async operators(tenantId: string, w: TimeWindow): Promise<ZOperatorRow[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<ZOperatorRow[]>`
      SELECT e."operatorId", u."displayName", u.email,
             COUNT(*)::int AS "earningCount",
             COALESCE(SUM(e."commissionCents" + COALESCE(e."tipCents", 0) - e."reversedCents" - ${afterPayoutDebt('e')}), 0)::bigint AS "netCents"
        FROM operator_earnings e
        JOIN users u ON u.id = e."operatorId"
        LEFT JOIN payments p ON p.id = e."paymentId"
        LEFT JOIN wallet_consumptions c ON c.id = e."consumptionId"
       WHERE e."tenantId" = ${tenantId}::uuid
         AND (
           (p.status IN ${PAID_STATUSES_SQL} AND ${paymentAt('p')} >= ${w.from} AND ${paymentAt('p')} < ${w.to})
           OR (c."reversedAt" IS NULL AND c."createdAt" >= ${w.from} AND c."createdAt" < ${w.to})
         )
       GROUP BY e."operatorId", u."displayName", u.email
    `);
  }

  private async operatorPayouts(
    tenantId: string,
    w: TimeWindow,
  ): Promise<Array<Count & { totalCents: number | bigint | null }>> {
    return this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<Count & { totalCents: number | bigint | null }>>`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(po."totalCents"), 0)::bigint AS "totalCents"
        FROM operator_payouts po
       WHERE po."tenantId" = ${tenantId}::uuid
         AND po."createdAt" >= ${w.from} AND po."createdAt" < ${w.to}
    `);
  }

  /** Consumos del saldo del trimestre (informativo en el 303). */
  private async consumptionTotals(tenantId: string, w: TimeWindow): Promise<{ count: number; cents: number }> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<Count & { cents: number | bigint | null }>>`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(c."amountCents"), 0)::bigint AS cents
        FROM wallet_consumptions c
       WHERE c."tenantId" = ${tenantId}::uuid
         AND c."reversedAt" IS NULL
         AND c."createdAt" >= ${w.from} AND c."createdAt" < ${w.to}
    `);
    return { count: Number(rows[0]?.count ?? 0), cents: Number(rows[0]?.cents ?? 0) };
  }
}
