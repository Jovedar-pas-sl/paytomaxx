import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isHomeTopUpPayment } from '../home-topup/home-topup-rules';
import type {
  AdjustmentRows,
  CobroRow,
  ConsumoRow,
  DevolucionRow,
  LiquidacionRow,
  PagoSaldoRow,
  RecargaEfectivoRow,
  SectionLabeler,
} from './export-rows';
import { venueSectionLabeler } from './export-rows';
import type { TimeWindow } from './report-period';
import {
  REPORT_TX,
  PAID_EVENTS_SQL,
  PAID_STATUSES_SQL,
  afterPayoutDebt,
  linesJson,
  paymentAt,
  paymentRecordedAt,
  refundAt,
} from './reporting-sql';

/** Tope de filas por informe: un local con mucho movimiento hace ~10k cobros al mes. */
export const MAX_EXPORT_ROWS = 100_000;

/**
 * Las partes del personal de un cobro o de un consumo (export-rows StaffPart):
 * una por ganancia, con su puesto, para que cada una cuente donde toca (la
 * chica que cobró, la invitada a una copa y, si el local se la da, el
 * camarero). `where` filtra las ganancias (alias se).
 */
function staffJson(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    SELECT COALESCE(json_agg(json_build_object(
             'name', su."displayName",
             'email', su.email,
             'role', su.role::text,
             'commissionCents', se."commissionCents",
             'tipCents', COALESCE(se."tipCents", 0),
             'reversedCents', se."reversedCents",
             'reversedAfterPayoutCents', ${afterPayoutDebt('se')},
             'baseCents', se."paymentAmountCents",
             'invitation', se."paymentLineId" IS NOT NULL
           ) ORDER BY se."createdAt", se.id), '[]'::json)
      FROM operator_earnings se
      JOIN users su ON su.id = se."operatorId"
     WHERE ${where}
  )`;
}

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

  /**
   * Los nombres de sección del local (Ajustes → Secciones; los de fábrica de la
   * app si no los cambió) para el Z y los CSV, como en el resto del panel.
   * venues no tiene RLS: vale también en el cierre automático de las 08:00.
   */
  async sectionLabeler(tenantId: string): Promise<SectionLabeler> {
    const venue = await this.prisma.venue.findUnique({ where: { id: tenantId }, select: { sections: true } });
    return venueSectionLabeler(venue?.sections ?? null);
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
    // Solo las hechas: una devolución a la tarjeta queda PENDING hasta completarse.
    return capped(await this.prisma.$queryRaw<PagoSaldoRow[]>`
      SELECT wp.id,
             wp."createdAt" AS "at",
             wp."amountCents",
             wp.method,
             wp."bankReference",
             pb."displayName" AS "paidByName",
             pb.email AS "paidByEmail"
        FROM wallet_payouts wp
        LEFT JOIN users pb ON pb.id = wp."paidByUserId"
       WHERE wp."tenantId" = ${tenantId}::uuid
         AND wp."status" = 'DONE'
         AND wp."createdAt" >= ${p.from}
         AND wp."createdAt" < ${p.to}
       ORDER BY wp."createdAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `);
  }

  /**
   * Recargas del saldo en efectivo cobradas en este local en el periodo (por
   * cuándo se cobraron), con sus anulaciones (filas negativas, por cuándo se
   * anularon). Para un Z: las apuntadas antes de generarlo. En withTenant:
   * FORCE RLS.
   */
  async recargasEfectivo(tenantId: string, p: TimeWindow, asOf: AsOf = {}): Promise<RecargaEfectivoRow[]> {
    const recorded = asOf.recordedBefore ? Prisma.sql`AND ct."createdAt" < ${asOf.recordedBefore}` : Prisma.empty;
    return capped(await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<RecargaEfectivoRow[]>`
      SELECT ct.id,
             ct."createdAt" AS "at",
             ct."amountCents",
             ct."serviceFeeCents",
             ct."voidOfId",
             ct.reason,
             ct."createdWallet",
             u."displayName" AS "takenByName",
             u.email AS "takenByEmail",
             t.label AS "terminalLabel"
        FROM wallet_cash_topups ct
        LEFT JOIN users u ON u.id = ct."takenByUserId"
        LEFT JOIN terminals t ON t.id = ct."terminalId"
       WHERE ct."tenantId" = ${tenantId}::uuid
         AND ct."createdAt" >= ${p.from}
         AND ct."createdAt" < ${p.to}
         ${recorded}
       ORDER BY ct."createdAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `, REPORT_TX));
  }

  /** Pagos al personal hechos en el periodo (a las chicas y, si tienen parte de las invitaciones, a los camareros). */
  async liquidaciones(tenantId: string, p: TimeWindow): Promise<LiquidacionRow[]> {
    return capped(await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<LiquidacionRow[]>`
      SELECT po.id,
             po."createdAt" AS "paidAt",
             po."totalCents",
             po."externalRail",
             po."externalTxId",
             po."reconciliationStatus",
             po.notes,
             u."displayName" AS "operatorName",
             u.email AS "operatorEmail",
             u.role::text AS role,
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
    `, REPORT_TX));
  }

  /** Cobros pagados del local que cumplen `where` (alias p), con su origen (withOrigin). */
  private async cobrosWhere(tenantId: string, where: Prisma.Sql): Promise<CobroRow[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<CobroDbRow[]>`
      SELECT p.id,
             ${paymentAt('p')} AS "paidAt",
             p.status::text AS status,
             p."amountCents",
             p."tipCents",
             p."serviceFeeCents",
             COALESCE(r."refundedFee", 0)::int AS "refundedServiceFeeCents",
             p."revenueCategory",
             pl.lines,
             p."captureMethod",
             p."serviceName",
             a."payMethod",
             p."payMethodCode",
             p."cardBrand",
             p."cardType",
             p."cardCountry",
             p."authCode",
             COALESCE(a."providerTxId", p."providerTxId", p."posOperationNumber") AS "providerTxId",
             p."walletId",
             -- Solo para el origen («Desde casa»): withOrigin no los deja en la fila.
             p."idempotencyKey",
             p."createdByUserId",
             u."displayName" AS "creatorName",
             u.email AS "creatorEmail",
             eu."displayName" AS "earningOperatorName",
             eu.email AS "earningOperatorEmail",
             COALESCE(r.refunded, 0)::int AS "refundedCents",
             e."commissionCents",
             e."tipCents" AS "earningTipCents",
             e."reversedCents",
             ${afterPayoutDebt('e')}::int AS "reversedAfterPayoutCents",
             ${staffJson(Prisma.sql`se."paymentId" = p.id`)} AS staff
        FROM payments p
        LEFT JOIN users u ON u.id = p."createdByUserId"
        -- Una fila por cobro. Las columnas de siempre, con una ganancia (la
        -- chica que cobró o la invitada); todas las partes del personal (las
        -- dos chicas, o el camarero si el local le da parte), en «staff».
        LEFT JOIN LATERAL (
          SELECT e0.* FROM operator_earnings e0
           WHERE e0."paymentId" = p.id
           ORDER BY (e0."operatorId" = p."createdByUserId" AND e0."paymentLineId" IS NOT NULL), e0."createdAt", e0.id
           LIMIT 1
        ) e ON true
        LEFT JOIN users eu ON eu.id = e."operatorId"
        LEFT JOIN LATERAL (
          SELECT SUM(rf."amountCents") AS refunded, SUM(rf."serviceFeeCents") AS "refundedFee"
            FROM refunds rf
           WHERE rf."paymentId" = p.id AND rf.status = 'SUCCEEDED'
        ) r ON true
        LEFT JOIN LATERAL (
          SELECT pa."payMethod", pa."providerTxId"
            FROM payment_attempts pa
           WHERE pa."paymentId" = p.id AND pa.status = 'APPROVED'
           ORDER BY pa."createdAt" ASC
           LIMIT 1
        ) a ON true
        -- Sus líneas, cada una en su sección (el Z y los informes suman por línea).
        LEFT JOIN LATERAL (
          SELECT ${linesJson('l')} AS lines FROM payment_lines l WHERE l."paymentId" = p.id
        ) pl ON true
       WHERE p."tenantId" = ${tenantId}::uuid
         AND p.status IN ${PAID_STATUSES_SQL}
         AND ${where}
       ORDER BY "paidAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `, REPORT_TX);
    return rows.map(withOrigin);
  }

  /** Consumos del saldo del local que cumplen `where` (alias c), con la parte de la chica si la hay. */
  private consumosWhere(tenantId: string, where: Prisma.Sql): Promise<ConsumoRow[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<ConsumoRow[]>`
      SELECT c.id,
             c."createdAt" AS "at",
             c."amountCents",
             c."tipCents",
             c.category,
             cl.lines,
             u."displayName" AS "operatorName",
             u.email AS "operatorEmail",
             e."commissionCents",
             e."tipCents" AS "earningTipCents",
             ${staffJson(Prisma.sql`se."consumptionId" = c.id`)} AS staff
        FROM wallet_consumptions c
        -- Una fila por consumo (como arriba: todas las partes, en «staff»).
        LEFT JOIN LATERAL (
          SELECT e0.* FROM operator_earnings e0
           WHERE e0."consumptionId" = c.id
           ORDER BY (e0."operatorId" = c."providedByUserId" AND e0."paymentLineId" IS NOT NULL), e0."createdAt", e0.id
           LIMIT 1
        ) e ON true
        LEFT JOIN users u ON u.id = e."operatorId"
        -- Las líneas del cobro del saldo que dejó este consumo.
        LEFT JOIN LATERAL (
          SELECT ${linesJson('l')} AS lines
            FROM wallet_charge_requests w
            JOIN payment_lines l ON l."walletChargeId" = w.id
           WHERE w."consumptionId" = c.id
        ) cl ON true
       WHERE c."tenantId" = ${tenantId}::uuid
         AND ${where}
       ORDER BY c."createdAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `, REPORT_TX);
  }

  /** Devoluciones hechas del local que cumplen `where` (alias r), con lo descontado a la chica. */
  private devolucionesWhere(tenantId: string, where: Prisma.Sql): Promise<DevolucionRow[]> {
    return this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<DevolucionRow[]>`
      SELECT r.id,
             ${refundAt('r')} AS "refundedAt",
             r."amountCents",
             r."serviceFeeCents",
             r.reason,
             r."providerRefundId",
             r."registeredManually",
             ru."displayName" AS "byName",
             ru.email AS "byEmail",
             p.id AS "paymentId",
             ${paymentAt('p')} AS "paidAt",
             p."providerTxId",
             (p."amountCents" + p."serviceFeeCents" + p."tipCents")::int AS "chargedCents",
             cu."displayName" AS "creatorName",
             cu.email AS "creatorEmail",
             eu."displayName" AS "chicaName",
             eu.email AS "chicaEmail",
             er."reversedDeltaCents",
             er."afterPayout",
             -- Lo descontado a cada persona (chicas y, si tenía parte, el camarero).
             (SELECT COALESCE(json_agg(json_build_object(
                       'name', su."displayName",
                       'email', su.email,
                       'role', su.role::text,
                       'reversedDeltaCents', sr."reversedDeltaCents",
                       'afterPayout', sr."afterPayout"
                     ) ORDER BY sr."createdAt", sr.id), '[]'::json)
                FROM earning_reversals sr
                JOIN operator_earnings se ON se.id = sr."earningId"
                JOIN users su ON su.id = se."operatorId"
               WHERE sr."refundId" = r.id) AS staff
        FROM refunds r
        JOIN payments p ON p.id = r."paymentId"
        LEFT JOIN users ru ON ru.id = r."requestedBy"
        LEFT JOIN users cu ON cu.id = p."createdByUserId"
        -- Una fila por devolución: lo descontado a una chica (la que cobró o
        -- la invitada) en las columnas de siempre; a cada persona, en «staff».
        LEFT JOIN LATERAL (
          SELECT er0.*, ee0."operatorId" AS "operatorId"
            FROM earning_reversals er0
            JOIN operator_earnings ee0 ON ee0.id = er0."earningId"
           WHERE er0."refundId" = r.id
           ORDER BY (ee0."operatorId" = p."createdByUserId" AND ee0."paymentLineId" IS NOT NULL), er0."createdAt", er0.id
           LIMIT 1
        ) er ON true
        LEFT JOIN operator_earnings ee ON ee.id = er."earningId"
        LEFT JOIN users eu ON eu.id = ee."operatorId"
       WHERE r."tenantId" = ${tenantId}::uuid
         AND r.status = 'SUCCEEDED'
         AND ${where}
       ORDER BY "refundedAt" ASC
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `, REPORT_TX);
  }
}

/** Un informe recortado parecería completo: mejor pedir un periodo más corto. */
function capped<T>(rows: T[]): T[] {
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new BadRequestException('Demasiadas filas para un solo archivo: elige un periodo más corto');
  }
  return rows;
}

/** Un cobro tal como sale de la base: la clave y quién lo creó solo sirven para withOrigin. */
type CobroDbRow = CobroRow & { idempotencyKey: string | null; createdByUserId: string | null };

/**
 * «Desde casa» (columna «Origen»): la carga que hizo el cliente con el enlace
 * del local (isHomeTopUpPayment). La clave y quién creó el cobro no siguen en
 * la fila: no llegan a ningún CSV ni al Z.
 */
function withOrigin({ idempotencyKey, createdByUserId, ...row }: CobroDbRow): CobroRow {
  return isHomeTopUpPayment({ idempotencyKey, createdByUserId }) ? { ...row, fromHome: true } : row;
}
