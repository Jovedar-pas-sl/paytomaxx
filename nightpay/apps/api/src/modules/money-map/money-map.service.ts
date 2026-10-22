import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MoneyMap, MoneyMapPayoutGroup, MoneyMapQuery, MoneyMapScope, NightCash } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { lastNightCutoff } from '../../common/time/madrid';
import { cashFromRows, zStart } from '../nights/night-rules';
import { parseReportPeriod, type TimeWindow } from '../reports/report-period';
import { MAX_EXPORT_ROWS, ReportsService } from '../reports/reports.service';
import { PAID_STATUSES_SQL, cashTopUpCount, linesJson, paymentAt, paymentRecordedAt, refundAt } from '../reports/reporting-sql';
import {
  buildMoneyMap,
  frozenMoneyMapOf,
  saleMethodOf,
  type SaleLineLike,
  type SaleRow,
  type StaffShare,
} from './money-map-rules';

/** Opciones de un cálculo del mapa. */
export interface MoneyMapOptions {
  scope: MoneyMapScope;
  now: Date;
  /** Para el Z: solo lo apuntado antes de este instante (como ReportsService, AsOf). */
  recordedBefore?: Date;
  /** Fondo de caja de la noche (null: no se apuntó / un periodo). */
  openingFloatCents: number | null;
  /** La caja ya calculada (al cerrar, la misma del Z). Sin ella se calcula como en el cierre. */
  cash?: CashBoxLike;
  /** Saldo vivo y lo que se debe al personal «ahora» (si el periodo llega hasta ahora). */
  withLiveBalances: boolean;
  /** Para congelarlo en el Z. */
  frozen?: boolean;
}

/** «Esta noche» en directo (currentWindow). */
export interface CurrentWindow extends TimeWindow {
  nightId: string | null;
  open: boolean;
  openingFloatCents: number | null;
}

/** Lo que el mapa lee de la caja de la noche (NightCash o el bloque «Caja» del Z). */
export type CashBoxLike = Pick<NightCash, 'openingFloatCents' | 'cashInCents' | 'cashOutCents' | 'expectedCents'>;

type Num = number | bigint | null;
const n = (v: Num | undefined): number => Number(v ?? 0);

interface PaymentSaleRow {
  amountCents: number;
  tipCents: number;
  category: string;
  captureMethod: string | null;
  posOperationNumber: string | null;
  platformBps: number | null;
  approvedPayMethod: string | null;
  lines: SaleLineLike[] | null;
}

interface ConsumptionSaleRow {
  amountCents: number;
  tipCents: number;
  category: string;
  lines: SaleLineLike[] | null;
}

const NO_STAFF: StaffShare = { grossCents: 0, unpaidCents: 0 };

/**
 * El mapa del dinero del panel (GET /v1/admin/money-map): la noche en
 * directo, la de un Z (congelada al cerrar, money-map-rules) o unas fechas.
 * SQL con el local explícito y las reglas de reporting-sql.ts (las mismas
 * fechas y filtros que el Z y los informes); la caja, con la misma cuenta
 * que el arqueo del cierre (night-rules.cashFromRows). Sin IVA.
 */
@Injectable()
export class MoneyMapService {
  private readonly prisma: PrismaService;
  private readonly reports: ReportsService;
  private readonly bankFeeBps: number | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ReportsService) reports: ReportsService,
    @Optional() @Inject(ConfigService) config?: ConfigService,
  ) {
    this.prisma = prisma;
    this.reports = reports;
    const fee = config?.get<number | undefined>('BANK_CARD_FEE_BPS');
    this.bankFeeBps = typeof fee === 'number' && Number.isFinite(fee) ? fee : null;
  }

  /** Lo que pide el panel: ?night=current|<id> o ?from&to (días de Madrid). */
  async forQuery(tenantId: string, q: MoneyMapQuery, now: Date = new Date()): Promise<MoneyMap> {
    if (q.from && q.to) {
      const parsed = parseReportPeriod(q.from, q.to);
      if (!parsed.ok) throw new BadRequestException(parsed.error);
      const window = { from: parsed.period.from, to: parsed.period.to };
      const live = window.to.getTime() > now.getTime();
      return this.compute(tenantId, { from: window.from, to: live ? now : window.to }, {
        scope: { kind: 'period' },
        now,
        openingFloatCents: null,
        withLiveBalances: live,
      });
    }
    if (!q.night || q.night === 'current') return this.current(tenantId, now);
    return this.ofNight(tenantId, q.night, now);
  }

  /**
   * «Esta noche» en directo: la abierta, desde donde cuenta su Z (el cierre de
   * la anterior); sin noche abierta, desde el último cierre (o las 08:00). La
   * usan el mapa en directo y las fichas de la chica y del camarero.
   */
  async currentWindow(tenantId: string, now: Date = new Date()): Promise<CurrentWindow> {
    const open = await this.prisma.asSystem((tx) =>
      tx.venueNight.findFirst({ where: { tenantId, closedAt: null }, orderBy: { openedAt: 'desc' } }),
    );
    if (open) return this.openWindow(tenantId, open, now);
    const last = await this.prisma.asSystem((tx) =>
      tx.venueNight.findFirst({ where: { tenantId, closedAt: { not: null } }, orderBy: { closedAt: 'desc' }, select: { closedAt: true } }),
    );
    return { from: last?.closedAt ?? lastNightCutoff(now), to: now, nightId: null, open: false, openingFloatCents: null };
  }

  private async current(tenantId: string, now: Date): Promise<MoneyMap> {
    return this.ofWindow(tenantId, await this.currentWindow(tenantId, now), now);
  }

  private async ofNight(tenantId: string, nightId: string, now: Date): Promise<MoneyMap> {
    const night = await this.prisma.asSystem((tx) => tx.venueNight.findFirst({ where: { id: nightId, tenantId } }));
    if (!night) throw new NotFoundException('Noche no encontrada');
    if (!night.closedAt) return this.ofWindow(tenantId, await this.openWindow(tenantId, night, now), now);
    const frozen = frozenMoneyMapOf(night.zReport);
    if (frozen) return frozen;
    // Un Z de antes del mapa: se calcula con la ventana y el corte de su Z.
    const z = (night.zReport ?? {}) as { from?: string; to?: string; generatedAt?: string; caja?: CashBoxLike };
    const window = { from: new Date(z.from ?? night.openedAt), to: new Date(z.to ?? night.closedAt) };
    return this.compute(tenantId, window, {
      scope: { kind: 'night', nightId: night.id, open: false },
      now,
      recordedBefore: z.generatedAt ? new Date(z.generatedAt) : night.closedAt,
      openingFloatCents: night.openingFloatCents,
      // La caja de su Z (los Z de antes del 16-oct-2026 no la traen: se calcula).
      ...(z.caja ? { cash: z.caja } : {}),
      withLiveBalances: false,
    });
  }

  /** La noche abierta: desde donde cuenta su Z (el cierre de la anterior), como el Z en vivo. */
  private async openWindow(
    tenantId: string,
    night: { id: string; openedAt: Date; openingFloatCents: number | null },
    now: Date,
  ): Promise<CurrentWindow> {
    const previous = await this.prisma.asSystem((tx) =>
      tx.venueNight.findFirst({
        where: { tenantId, closedAt: { not: null, lte: night.openedAt } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true, zReport: true },
      }),
    );
    const { from } = zStart(previous, night.openedAt);
    return { from, to: now, nightId: night.id, open: true, openingFloatCents: night.openingFloatCents };
  }

  /** En directo: con el corte de ahora (como el Z en vivo) y el saldo vivo. */
  private ofWindow(tenantId: string, w: CurrentWindow, now: Date): Promise<MoneyMap> {
    return this.compute(tenantId, { from: w.from, to: w.to }, {
      scope: { kind: 'night', nightId: w.nightId, open: w.open },
      now,
      ...(w.open ? { recordedBefore: now } : {}),
      openingFloatCents: w.openingFloatCents,
      withLiveBalances: true,
    });
  }

  /** El mapa de un periodo [from, to) del local. */
  async compute(tenantId: string, window: TimeWindow, opts: MoneyMapOptions): Promise<MoneyMap> {
    const asOf = opts.recordedBefore;
    const paid = paidPayments(tenantId, window, asOf);
    const consumed = activeConsumptions(tenantId, window, asOf);
    const [venue, sales, money, cash, live] = await Promise.all([
      this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: tenantId }, select: { platformCommissionBps: true } })),
      this.prisma.withTenant(tenantId, (tx) => this.salesRows(tx, paid, consumed)),
      this.prisma.withTenant(tenantId, (tx) => this.moneyRows(tx, tenantId, window, asOf, paid, consumed)),
      opts.cash ? Promise.resolve(opts.cash) : this.cashOf(tenantId, window, asOf, opts.openingFloatCents),
      opts.withLiveBalances ? this.prisma.withTenant(tenantId, (tx) => liveBalances(tx, tenantId)) : Promise.resolve(null),
    ]);
    if (!venue) throw new NotFoundException('Local no encontrado');
    const saleRows: SaleRow[] = [
      ...sales.payments.map(
        (p): SaleRow => ({
          amountCents: p.amountCents,
          tipCents: p.tipCents,
          category: p.category,
          method: saleMethodOf(p),
          platformBps: n(p.platformBps ?? venue.platformCommissionBps),
          lines: p.lines ?? [],
        }),
      ),
      ...sales.consumptions.map(
        (c): SaleRow => ({
          amountCents: c.amountCents,
          tipCents: c.tipCents,
          category: c.category,
          method: 'SALDO',
          platformBps: venue.platformCommissionBps,
          lines: c.lines ?? [],
        }),
      ),
    ];
    return buildMoneyMap({
      scope: opts.scope,
      window,
      now: opts.now,
      frozen: opts.frozen ?? false,
      sales: saleRows,
      topUps: money.topUps,
      staff: money.staff,
      cardRefunds: money.cardRefunds,
      walletPayouts: money.walletPayouts,
      payouts: money.payouts,
      cashBox: {
        openingFloatCents: cash.openingFloatCents,
        inCents: cash.cashInCents,
        outCents: cash.cashOutCents,
        expectedCents: cash.expectedCents,
      },
      bankFeeBps: this.bankFeeBps,
      liveSaldoCents: live?.saldoCents ?? null,
      owed: live?.owed ?? null,
    });
  }

  /** La caja con la misma cuenta que el arqueo del cierre (las mismas filas que el Z). */
  private async cashOf(tenantId: string, window: TimeWindow, asOf: Date | undefined, float: number | null): Promise<CashBoxLike> {
    const [recargasEfectivo, pagosSaldo, liquidaciones] = await Promise.all([
      this.reports.recargasEfectivo(tenantId, window, { recordedBefore: asOf }),
      this.reports.pagosSaldo(tenantId, window),
      this.reports.liquidaciones(tenantId, window),
    ]);
    return cashFromRows(float, { recargasEfectivo, pagosSaldo, liquidaciones });
  }

  /** Las ventas: cobros con tarjeta (sin recargas) y consumos del saldo, con sus líneas. */
  private async salesRows(
    tx: TransactionalClient,
    paid: Prisma.Sql,
    consumed: Prisma.Sql,
  ): Promise<{ payments: PaymentSaleRow[]; consumptions: ConsumptionSaleRow[] }> {
    const payments = await tx.$queryRaw<PaymentSaleRow[]>`
      SELECT p."amountCents", p."tipCents", p."revenueCategory" AS category, p."captureMethod",
             p."posOperationNumber", p."platformCommissionBps" AS "platformBps",
             a."payMethod" AS "approvedPayMethod", l.lines
        FROM payments p
        LEFT JOIN LATERAL (
          SELECT pa."payMethod" FROM payment_attempts pa
           WHERE pa."paymentId" = p.id AND pa.status = 'APPROVED'
           ORDER BY pa."createdAt" ASC LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT ${linesJson('pl')} AS lines FROM payment_lines pl WHERE pl."paymentId" = p.id
        ) l ON true
       WHERE ${paid} AND p."walletId" IS NULL
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `;
    const consumptions = await tx.$queryRaw<ConsumptionSaleRow[]>`
      SELECT c."amountCents", c."tipCents", c.category, l.lines
        FROM wallet_consumptions c
        LEFT JOIN LATERAL (
          SELECT ${linesJson('pl')} AS lines
            FROM wallet_charge_requests w
            JOIN payment_lines pl ON pl."walletChargeId" = w.id
           WHERE w."consumptionId" = c.id
        ) l ON true
       WHERE ${consumed}
       LIMIT ${MAX_EXPORT_ROWS + 1}
    `;
    if (payments.length > MAX_EXPORT_ROWS || consumptions.length > MAX_EXPORT_ROWS) {
      throw new BadRequestException('Demasiados cobros para un solo mapa: elige un periodo más corto');
    }
    return { payments, consumptions };
  }

  /** Recargas, lo del personal, devoluciones y pagos al personal del periodo. */
  private async moneyRows(
    tx: TransactionalClient,
    tenantId: string,
    w: TimeWindow,
    asOf: Date | undefined,
    paid: Prisma.Sql,
    consumed: Prisma.Sql,
  ) {
    const recordedRefund = asOf ? Prisma.sql`AND r."createdAt" < ${asOf}` : Prisma.empty;
    const recordedCash = asOf ? Prisma.sql`AND ct."createdAt" < ${asOf}` : Prisma.empty;
    const [totals] = await tx.$queryRaw<Array<Record<string, Num>>>`
      WITH recargas AS (
        SELECT COUNT(*)::int AS "cardCount", COALESCE(SUM(p."amountCents" + p."tipCents"), 0)::bigint AS "cardCents"
          FROM payments p WHERE ${paid} AND p."walletId" IS NOT NULL
      ), efectivo AS (
        SELECT ${cashTopUpCount('ct')}::int AS "cashCount", COALESCE(SUM(ct."amountCents"), 0)::bigint AS "cashCents"
          FROM wallet_cash_topups ct
         WHERE ct."tenantId" = ${tenantId}::uuid AND ct."createdAt" >= ${w.from} AND ct."createdAt" < ${w.to} ${recordedCash}
      ), devoluciones AS (
        SELECT COUNT(*)::int AS "refundCount", COALESCE(SUM(r."amountCents"), 0)::bigint AS "refundCents"
          FROM refunds r
         WHERE r."tenantId" = ${tenantId}::uuid AND r.status = 'SUCCEEDED'
           AND ${refundAt('r')} >= ${w.from} AND ${refundAt('r')} < ${w.to} ${recordedRefund}
      ), saldo AS (
        SELECT COUNT(*) FILTER (WHERE wp.method = 'CASH')::int AS "walletCashCount",
               COALESCE(SUM(wp."amountCents") FILTER (WHERE wp.method = 'CASH'), 0)::bigint AS "walletCashCents",
               COALESCE(SUM(wp."amountCents") FILTER (WHERE wp.method = 'CARD'), 0)::bigint AS "walletCardCents"
          FROM wallet_payouts wp
         WHERE wp."tenantId" = ${tenantId}::uuid AND wp.status = 'DONE'
           AND wp."createdAt" >= ${w.from} AND wp."createdAt" < ${w.to}
      )
      SELECT * FROM recargas, efectivo, devoluciones, saldo
    `;
    // Lo del personal: su parte de lo vendido en el periodo (comisión y
    // propinas) menos lo que se le descontó por las devoluciones del periodo
    // (de un cobro de este periodo o de antes, como el Z): eso vuelve al
    // local, que es quien devuelve el dinero (Qué sale). Lo que aún no se le
    // ha pagado, de lo vendido en el periodo.
    const staffRows = await tx.$queryRaw<Array<{ chica: boolean; gross: Num; unpaid: Num }>>`
      SELECT x.chica,
             COALESCE(SUM(x.gross), 0)::bigint AS gross,
             COALESCE(SUM(x.unpaid), 0)::bigint AS unpaid
        FROM (
          SELECT (u.role = 'OPERATOR') AS chica,
                 e."commissionCents" + COALESCE(e."tipCents", 0) AS gross,
                 CASE WHEN e."payoutId" IS NULL
                      THEN e."commissionCents" + COALESCE(e."tipCents", 0) - e."reversedCents"
                      ELSE 0 END AS unpaid
            FROM operator_earnings e
            JOIN users u ON u.id = e."operatorId"
           WHERE e."tenantId" = ${tenantId}::uuid
             AND (
               e."paymentId" IN (SELECT p.id FROM payments p WHERE ${paid} AND p."walletId" IS NULL)
               OR e."consumptionId" IN (SELECT c.id FROM wallet_consumptions c WHERE ${consumed})
             )
          UNION ALL
          SELECT (u.role = 'OPERATOR'), -er."reversedDeltaCents", 0
            FROM earning_reversals er
            JOIN refunds r ON r.id = er."refundId"
            JOIN operator_earnings re ON re.id = er."earningId"
            JOIN users u ON u.id = re."operatorId"
           WHERE r."tenantId" = ${tenantId}::uuid AND r.status = 'SUCCEEDED'
             AND ${refundAt('r')} >= ${w.from} AND ${refundAt('r')} < ${w.to} ${recordedRefund}
        ) x
       GROUP BY 1
    `;
    const payoutRows = await tx.$queryRaw<Array<{ chica: boolean; rail: string | null; count: Num; cents: Num }>>`
      SELECT (u.role = 'OPERATOR') AS chica, po."externalRail" AS rail,
             COUNT(*)::int AS count, COALESCE(SUM(po."totalCents"), 0)::bigint AS cents
        FROM operator_payouts po
        JOIN users u ON u.id = po."operatorId"
       WHERE po."tenantId" = ${tenantId}::uuid AND po."createdAt" >= ${w.from} AND po."createdAt" < ${w.to}
       GROUP BY 1, 2
    `;
    const t = totals ?? {};
    const share = (chica: boolean): StaffShare => {
      const row = staffRows.find((s) => s.chica === chica);
      return row ? { grossCents: n(row.gross), unpaidCents: n(row.unpaid) } : NO_STAFF;
    };
    const payouts: MoneyMapPayoutGroup[] = payoutRows.map((p) => ({
      who: p.chica ? 'chicas' : 'camareros',
      rail: p.rail,
      count: n(p.count),
      cents: n(p.cents),
    }));
    return {
      topUps: { cardCents: n(t.cardCents), cardCount: n(t.cardCount), cashCents: n(t.cashCents), cashCount: n(t.cashCount) },
      staff: { chicas: share(true), camareros: share(false) },
      cardRefunds: { cents: n(t.refundCents), count: n(t.refundCount) },
      walletPayouts: { cashCents: n(t.walletCashCents), cashCount: n(t.walletCashCount), cardCents: n(t.walletCardCents) },
      payouts,
    };
  }
}

/** Cobros pagados del periodo (alias p): mismas fechas que el Z y, para un Z, lo apuntado antes del corte. */
function paidPayments(tenantId: string, w: TimeWindow, asOf: Date | undefined): Prisma.Sql {
  const recorded = asOf ? Prisma.sql`AND ${paymentRecordedAt('p')} < ${asOf}` : Prisma.empty;
  return Prisma.sql`p."tenantId" = ${tenantId}::uuid
         AND p.status IN ${PAID_STATUSES_SQL}
         AND ${paymentAt('p')} >= ${w.from} AND ${paymentAt('p')} < ${w.to} ${recorded}`;
}

/** Consumos del saldo del periodo (alias c). Para un Z, los anulados después aún cuentan (como el Z). */
function activeConsumptions(tenantId: string, w: TimeWindow, asOf: Date | undefined): Prisma.Sql {
  const active = asOf ? Prisma.sql`(c."reversedAt" IS NULL OR c."reversedAt" >= ${asOf})` : Prisma.sql`c."reversedAt" IS NULL`;
  return Prisma.sql`c."tenantId" = ${tenantId}::uuid AND ${active}
         AND c."createdAt" >= ${w.from} AND c."createdAt" < ${w.to}`;
}

/** Saldo vivo de los clientes del local y lo que se debe al personal, ahora (comisiones sin pagar − deudas). */
async function liveBalances(
  tx: TransactionalClient,
  tenantId: string,
): Promise<{ saldoCents: number; owed: { chicasCents: number; camarerosCents: number } }> {
  const [saldo] = await tx.$queryRaw<Array<{ cents: Num }>>`
    SELECT COALESCE(SUM("balanceCents"), 0)::bigint AS cents
      FROM client_wallets
     WHERE "tenantId" = ${tenantId}::uuid AND status = 'ACTIVE' AND "mergedIntoId" IS NULL
  `;
  const owed = await tx.$queryRaw<Array<{ chica: boolean; cents: Num }>>`
    SELECT x.chica, COALESCE(SUM(x.cents), 0)::bigint AS cents
      FROM (
        SELECT (u.role = 'OPERATOR') AS chica, e."commissionCents" + COALESCE(e."tipCents", 0) - e."reversedCents" AS cents
          FROM operator_earnings e JOIN users u ON u.id = e."operatorId"
         WHERE e."tenantId" = ${tenantId}::uuid AND e."payoutId" IS NULL
        UNION ALL
        -- Devoluciones llegadas con la comisión ya pagada: se descuentan del próximo pago.
        SELECT (u.role = 'OPERATOR'), -r."reversedDeltaCents"
          FROM earning_reversals r
          JOIN operator_earnings e ON e.id = r."earningId"
          JOIN users u ON u.id = e."operatorId"
         WHERE e."tenantId" = ${tenantId}::uuid AND r."afterPayout" AND r."settledPayoutId" IS NULL
      ) x
     GROUP BY x.chica
  `;
  const of = (chica: boolean) => n(owed.find((o) => o.chica === chica)?.cents);
  return { saldoCents: n(saldo?.cents), owed: { chicasCents: of(true), camarerosCents: of(false) } };
}
