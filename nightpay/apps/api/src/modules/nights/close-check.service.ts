import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { expectedCashCents, withServiceFee, type NightCash, type NightChicaPay, type NightCloseCheck } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IncidentsService } from '../incidents/incidents.service';
import { earningBankHeldSql, earningNetSql } from '../operators/bank-hold-sql';
import { payoutCutoff } from '../operators/payout-math';
import { venueHoldDays } from '../operators/venue-hold-days';
import { PAID_STATUSES_SQL, cashTopUpCount, paymentAt } from '../reports/reporting-sql';
import type { TimeWindow } from '../reports/report-period';
import {
  buildCloseSteps,
  chicaPay,
  type ChicaBalanceRow,
  type PendingRefundRow,
  type PosStartedRow,
  type PosUnreconciledRow,
  type UnresolvedPaymentRow,
  type WalletCloseRequestedRow,
  type WalletPayoutPendingRow,
} from './close-check-rules';
import { unresolvedPaymentsWhere } from './night-rules';
import { bitcoinCashOut } from '../bitcoin-cash/bitcoin-cash-rows';

/** Cuántas filas de cada cosa como mucho (el número de la lista es aparte). */
const ROW_LIMIT = 100;

/** La noche abierta que se va a cerrar. */
export interface NightToCheck {
  id: string;
  openedAt: Date;
  openingFloatCents: number | null;
}

/**
 * Cierre de la noche en pasos: lee lo que falta por hacer antes de congelar
 * el Z (cobros, datáfonos, saldo, efectivo, chicas, incidencias) y lo pasa
 * por las reglas de close-check-rules. SQL crudo con el local explícito; las
 * tablas con FORCE RLS (chicas, saldo), dentro de withTenant.
 */
@Injectable()
export class CloseCheckService {
  private readonly prisma: PrismaService;
  private readonly incidents: IncidentsService;
  private readonly config: ConfigService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(IncidentsService) incidents: IncidentsService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prisma = prisma;
    this.incidents = incidents;
    this.config = config;
  }

  /**
   * Los pasos del cierre de la noche en `now` (window = desde el cierre
   * anterior hasta now). Al cerrar, `knownCash` es el efectivo sacado de las
   * mismas filas que el Z (night-rules.cashFromRows): la caja y el Z cuadran.
   */
  async check(
    tenantId: string,
    night: NightToCheck,
    window: TimeWindow,
    now: Date,
    knownCash?: NightCash,
  ): Promise<NightCloseCheck> {
    const holdDays = await venueHoldDays(this.prisma, this.config.get('PAYOUT_HOLD_DAYS'), tenantId);
    const [payments, refunds, posStarted, posUnreconciled, pairedDevices, saldo, cash, chicas, incidents] =
      await Promise.all([
        this.unresolvedPayments(tenantId, window),
        this.pendingRefunds(tenantId, window),
        this.posStarted(tenantId, window),
        this.posUnreconciled(tenantId, window),
        this.pairedDevices(tenantId),
        this.saldoPending(tenantId),
        knownCash ?? this.cash(tenantId, window, night.openingFloatCents),
        this.chicas(tenantId, window, payoutCutoff(now, holdDays)),
        this.incidents.list(tenantId, now),
      ]);
    return {
      nightId: night.id,
      openedAt: night.openedAt.toISOString(),
      from: window.from.toISOString(),
      generatedAt: now.toISOString(),
      holdDays,
      steps: buildCloseSteps({
        now,
        holdDays,
        payments,
        refunds,
        posStarted,
        posUnreconciled,
        pairedDevices,
        walletPayouts: saldo.payouts,
        walletsToClose: saldo.toClose,
        cash,
        chicas,
        incidents,
      }),
      cash,
      chicas,
    };
  }

  /**
   * Efectivo de la noche en la misma ventana que el Z: lo que entra (recargas
   * del saldo en efectivo cobradas en este local) y lo que sale (saldo
   * devuelto en efectivo, pagos en efectivo a las chicas y, aparte, a los
   * camareros).
   */
  async cash(tenantId: string, window: TimeWindow, openingFloatCents: number | null): Promise<NightCash> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{
        topUpCount: number;
        topUpCents: number;
        topUpFeeCents?: number;
        walletCount: number;
        walletCents: number;
        chicaCount: number;
        chicaCents: number;
        camareroCount: number;
        camareroCents: number;
      }>
    >`
      WITH staff AS (
        SELECT (u.role = 'WAITER') AS camarero, po."totalCents"
          FROM operator_payouts po
          JOIN users u ON u.id = po."operatorId"
         WHERE po."tenantId" = ${tenantId}::uuid AND po."externalRail" = 'MANUAL_CASH'
           AND po."createdAt" >= ${window.from} AND po."createdAt" < ${window.to}
      )
      SELECT
        (SELECT ${cashTopUpCount('ct')}::int FROM wallet_cash_topups ct
          WHERE ct."tenantId" = ${tenantId}::uuid
            AND ct."createdAt" >= ${window.from} AND ct."createdAt" < ${window.to}) AS "topUpCount",
        (SELECT COALESCE(SUM(ct."amountCents"), 0)::int FROM wallet_cash_topups ct
          WHERE ct."tenantId" = ${tenantId}::uuid
            AND ct."createdAt" >= ${window.from} AND ct."createdAt" < ${window.to}) AS "topUpCents",
        (SELECT COALESCE(SUM(ct."serviceFeeCents"), 0)::int FROM wallet_cash_topups ct
          WHERE ct."tenantId" = ${tenantId}::uuid
            AND ct."createdAt" >= ${window.from} AND ct."createdAt" < ${window.to}) AS "topUpFeeCents",
        (SELECT COUNT(*)::int FROM wallet_payouts wp
          WHERE wp."tenantId" = ${tenantId}::uuid AND wp.method = 'CASH' AND wp.status = 'DONE'
            AND wp."createdAt" >= ${window.from} AND wp."createdAt" < ${window.to}) AS "walletCount",
        (SELECT COALESCE(SUM(wp."amountCents"), 0)::int FROM wallet_payouts wp
          WHERE wp."tenantId" = ${tenantId}::uuid AND wp.method = 'CASH' AND wp.status = 'DONE'
            AND wp."createdAt" >= ${window.from} AND wp."createdAt" < ${window.to}) AS "walletCents",
        (SELECT COUNT(*)::int FROM staff WHERE NOT camarero) AS "chicaCount",
        (SELECT COALESCE(SUM("totalCents"), 0)::int FROM staff WHERE NOT camarero) AS "chicaCents",
        (SELECT COUNT(*)::int FROM staff WHERE camarero) AS "camareroCount",
        (SELECT COALESCE(SUM("totalCents"), 0)::int FROM staff WHERE camarero) AS "camareroCents"
    `);
    const r = rows[0] ?? {
      topUpCount: 0,
      topUpCents: 0,
      walletCount: 0,
      walletCents: 0,
      chicaCount: 0,
      chicaCents: 0,
      camareroCount: 0,
      camareroCents: 0,
    };
    // Entra el saldo + la «Comisión del servicio» de las recargas en efectivo.
    const feeCents = r.topUpFeeCents ?? 0;
    const cashInCents = r.topUpCents + feeCents;
    // Sale también lo pagado con bitcoin y devuelto en efectivo (el bitcoin se queda en la cartera).
    const btc = await this.prisma.withTenant(tenantId, (tx) => bitcoinCashOut(tx, tenantId, window));
    const cashOutCents = r.walletCents + r.chicaCents + r.camareroCents + btc.cents;
    return {
      openingFloatCents,
      cashInCents,
      walletCashTopUpsCount: r.topUpCount,
      walletCashTopUpsCents: r.topUpCents,
      ...withServiceFee({ walletCashTopUpFeesCents: feeCents }),
      walletCashPayoutsCount: r.walletCount,
      walletCashPayoutsCents: r.walletCents,
      chicaCashPayoutsCount: r.chicaCount,
      chicaCashPayoutsCents: r.chicaCents,
      camareroCashPayoutsCount: r.camareroCount,
      camareroCashPayoutsCents: r.camareroCents,
      ...(btc.count > 0 ? { bitcoinCashOutCount: btc.count, bitcoinCashOutCents: btc.cents } : {}),
      cashOutCents,
      expectedCents: expectedCashCents(openingFloatCents, { cashInCents, cashOutCents }),
    };
  }

  /** Cobros de la noche sin terminar: los mismos que cuentan en pendingAtClose. */
  private unresolvedPayments(tenantId: string, window: TimeWindow): Promise<UnresolvedPaymentRow[]> {
    return this.prisma.$queryRaw<UnresolvedPaymentRow[]>`
      SELECT id, status::text AS status, "amountCents", "captureMethod", "createdAt", "updatedAt",
             ("posOperationNumber" IS NOT NULL) AS "deviceSale", provider::text AS provider
        FROM payments
       WHERE ${unresolvedPaymentsWhere(tenantId, window)}
       ORDER BY "createdAt" ASC
       LIMIT ${ROW_LIMIT}
    `;
  }

  /** Devoluciones por la pasarela pedidas esta noche y aún sin confirmar. */
  private pendingRefunds(tenantId: string, window: TimeWindow): Promise<PendingRefundRow[]> {
    return this.prisma.$queryRaw<PendingRefundRow[]>`
      SELECT id, "amountCents", "createdAt"
        FROM refunds
       WHERE "tenantId" = ${tenantId}::uuid
         AND status = 'PENDING'
         AND "createdAt" >= ${window.from}
         AND "createdAt" < ${window.to}
       ORDER BY "createdAt" ASC
       LIMIT ${ROW_LIMIT}
    `;
  }

  /** Cobros que un datáfono empezó y de los que no llegó el resultado (sin pagar). */
  private posStarted(tenantId: string, window: TimeWindow): Promise<PosStartedRow[]> {
    return this.prisma.$queryRaw<PosStartedRow[]>`
      SELECT p.id, p."amountCents", p.status::text AS status, s."occurredAt" AS "startedAt", t.label AS "terminalLabel"
        FROM payments p
        JOIN LATERAL (
          SELECT e."occurredAt", e.payload ->> 'terminalId' AS "terminalId"
            FROM payment_events e
           WHERE e."paymentId" = p.id AND e."eventType" = 'pos.device_started'
           ORDER BY e."occurredAt" DESC
           LIMIT 1
        ) s ON true
        LEFT JOIN terminals t ON t.id::text = s."terminalId" AND t."tenantId" = p."tenantId"
       WHERE p."tenantId" = ${tenantId}::uuid
         -- Los de las chicas y las recargas de la recepción del datáfono.
         AND p."captureMethod" IN ('POS_EXTERNAL', 'WALLET_TOPUP')
         AND p.status::text NOT IN ${PAID_STATUSES_SQL}
         AND p."createdAt" >= ${window.from}
         AND p."createdAt" < ${window.to}
         AND NOT EXISTS (SELECT 1 FROM payment_events r
                          WHERE r."paymentId" = p.id AND r."eventType" = 'pos.device_result'
                            AND r."occurredAt" >= s."occurredAt")
       ORDER BY s."occurredAt" ASC
       LIMIT ${ROW_LIMIT}
    `;
  }

  /** Datáfonos con ventas de la noche cuyo último cuadre es anterior a su última venta (o no hay). */
  private posUnreconciled(tenantId: string, window: TimeWindow): Promise<PosUnreconciledRow[]> {
    return this.prisma.$queryRaw<PosUnreconciledRow[]>`
      SELECT x."terminalId", x.label, x.sales, x.cents, x."lastSaleAt", x."lastReportAt", x."lastSeenAt"
        FROM (
          SELECT t.id AS "terminalId", t.label, t."deviceLastSeenAt" AS "lastSeenAt",
                 COUNT(p.id)::int AS sales,
                 COALESCE(SUM(p."amountCents" + p."serviceFeeCents" + p."tipCents"), 0)::int AS cents,
                 MAX(${paymentAt('p')}) AS "lastSaleAt",
                 (SELECT MAX(o."reportedAt") FROM pos_terminal_ops o WHERE o."terminalId" = t.id) AS "lastReportAt"
            FROM terminals t
            JOIN payments p ON p."posTerminalId" = t.id AND p."tenantId" = t."tenantId"
           WHERE t."tenantId" = ${tenantId}::uuid
             AND p.status::text IN ${PAID_STATUSES_SQL}
             AND ${paymentAt('p')} >= ${window.from}
             AND ${paymentAt('p')} < ${window.to}
           GROUP BY t.id
        ) x
       WHERE x."lastReportAt" IS NULL OR x."lastReportAt" < x."lastSaleAt"
       ORDER BY x.label ASC
       LIMIT ${ROW_LIMIT}
    `;
  }

  private async pairedDevices(tenantId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM terminals
       WHERE "tenantId" = ${tenantId}::uuid AND active AND "deviceTokenHash" IS NOT NULL
    `;
    return rows[0]?.n ?? 0;
  }

  /** Saldo por devolver: a la tarjeta a medias y clientes que pidieron el suyo. */
  private saldoPending(
    tenantId: string,
  ): Promise<{ payouts: WalletPayoutPendingRow[]; toClose: WalletCloseRequestedRow[] }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // La devolución es de este local; el saldo puede ser de otro del grupo (entonces sin código).
      const payouts = await tx.$queryRaw<WalletPayoutPendingRow[]>`
        SELECT wp.id, wp."amountCents", wp."createdAt", w."shortCode"
          FROM wallet_payouts wp
          LEFT JOIN client_wallets w ON w.id = wp."walletId"
         WHERE wp."tenantId" = ${tenantId}::uuid AND wp.status = 'PENDING'
         ORDER BY wp."createdAt" ASC
         LIMIT ${ROW_LIMIT}
      `;
      const toClose = await tx.$queryRaw<WalletCloseRequestedRow[]>`
        SELECT id, "balanceCents", "shortCode"
          FROM client_wallets
         WHERE "tenantId" = ${tenantId}::uuid
           AND status = 'ACTIVE'
           AND "balanceCents" > 0
           AND "closeRequestedAt" IS NOT NULL
         ORDER BY "closeRequestedAt" ASC
         LIMIT ${ROW_LIMIT}
      `;
      return { payouts, toClose };
    });
  }

  /**
   * Por chica: lo no pagado (y cuánto sigue en espera con los días del local),
   * lo ganado y lo pagado desde el cierre anterior y su deuda abierta. Mismas
   * cuentas que el saldo de la chica y que createPayout (payout-math).
   */
  private async chicas(tenantId: string, window: TimeWindow, cutoff: Date): Promise<NightChicaPay[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<ChicaBalanceRow[]>`
      SELECT u.id AS "operatorId",
             COALESCE(u."displayName", u.email) AS name,
             u."payoutMethod", u."payoutAddress", u."payoutLabel",
             COALESCE(e.unpaid, 0)::int AS "unpaidCents",
             COALESCE(e.held, 0)::int AS "heldCents",
             COALESCE(e.bank, 0)::int AS "bankHeldCents",
             COALESCE(e.tonight, 0)::int AS "earnedTonightCents",
             COALESCE(p.paid, 0)::int AS "paidTonightCents",
             COALESCE(p.n, 0)::int AS "paidTonightCount",
             COALESCE(d.debt, 0)::int AS "debtCents"
        FROM users u
        LEFT JOIN (
          -- Lo retenido (venta por datáfono sin cuadrar, bank-hold-sql) no es «en espera»: va aparte.
          SELECT x."operatorId",
                 SUM(x.net) FILTER (WHERE x."payoutId" IS NULL) AS unpaid,
                 SUM(x.net) FILTER (WHERE x."payoutId" IS NULL AND NOT x.bank AND x."createdAt" > ${cutoff}) AS held,
                 SUM(x.net) FILTER (WHERE x.bank) AS bank,
                 SUM(x.net) FILTER (WHERE x."createdAt" >= ${window.from} AND x."createdAt" < ${window.to}) AS tonight
            FROM (
              SELECT e."operatorId", e."payoutId", e."createdAt", ${earningNetSql('e')} AS net,
                     (e."payoutId" IS NULL AND ${earningBankHeldSql('e')}) AS bank
                FROM operator_earnings e
               WHERE e."tenantId" = ${tenantId}::uuid
            ) x
           GROUP BY x."operatorId"
        ) e ON e."operatorId" = u.id
        LEFT JOIN (
          SELECT "operatorId", SUM("totalCents") AS paid, COUNT(*) AS n
            FROM operator_payouts
           WHERE "tenantId" = ${tenantId}::uuid
             AND "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
           GROUP BY "operatorId"
        ) p ON p."operatorId" = u.id
        LEFT JOIN (
          SELECT oe."operatorId", SUM(r."reversedDeltaCents") AS debt
            FROM earning_reversals r
            JOIN operator_earnings oe ON oe.id = r."earningId"
           WHERE oe."tenantId" = ${tenantId}::uuid AND r."afterPayout" AND r."settledPayoutId" IS NULL
           GROUP BY oe."operatorId"
        ) d ON d."operatorId" = u.id
       WHERE u."tenantId" = ${tenantId}::uuid
         -- Las chicas y los camareros con parte de las invitaciones (se les paga igual).
         AND u.role IN ('OPERATOR', 'WAITER')
         AND u."deletedAt" IS NULL
         AND (COALESCE(e.unpaid, 0) <> 0 OR COALESCE(e.tonight, 0) <> 0 OR p.n > 0 OR COALESCE(d.debt, 0) > 0)
       ORDER BY name ASC
       LIMIT ${ROW_LIMIT}
    `);
    return rows.map(chicaPay);
  }
}
