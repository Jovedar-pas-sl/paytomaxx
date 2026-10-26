import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OverviewBusiness, OverviewTotals, OverviewVenue, SuperAdminOverview } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IncidentsService } from '../incidents/incidents.service';
import { payableSummary, resolveHoldDays, type BalanceSums } from '../operators/payout-math';
import { PAID_STATUSES_SQL, paymentAt, refundAt } from '../reports/reporting-sql';
import { madridRecentDaysWindow, madridTodayWindow } from '../reports/reporting-window';
import { venuePauseScope } from '../venues/venue-pause';

/** La semana de la vista general: hoy y los 7 días anteriores (como las métricas del panel). */
const WEEK_PAST_DAYS = 7;
/** Bandejas de incidencias calculadas a la vez (cada una son ~12 consultas pequeñas). */
const INCIDENT_CONCURRENCY = 4;
const NO_BUSINESS = 'Sin negocio';

interface VenueRow {
  id: string;
  name: string;
  slug: string;
  businessId: string | null;
  businessName: string | null;
  businessStatus: 'ACTIVE' | 'PAUSED' | null;
  pausedAt: Date | null;
  payoutHoldDays: number | null;
  serviceFeeEnabled: boolean;
}

/** «Comisión del servicio» de la semana por local: cobrada − devuelta (lo que se debe a OxioPay). */
interface FeeRow {
  tenantId: string;
  feeWeek: bigint;
}

interface ChargeRow {
  tenantId: string;
  paymentsToday: number;
  chargedToday: bigint;
  chargedWeek: bigint;
}

interface EarningRow {
  tenantId: string;
  operatorId: string;
  unpaidCents: bigint;
  heldCents: bigint;
}

interface DebtRow {
  tenantId: string;
  operatorId: string;
  debtCents: bigint;
}

interface WalletRow {
  tenantId: string;
  wallets: number;
  balance: bigint;
}

/**
 * Vista general del super-admin: por negocio y por local, lo cobrado hoy y en
 * la semana (días de Madrid, mismas reglas que los informes), lo que hay que
 * pagar ya a las chicas (con los días de espera de cada local, como
 * Tesorería), el saldo vivo de los clientes y las incidencias abiertas.
 * El dinero sale de 5 consultas agregadas para TODOS los locales a la vez; las
 * incidencias, de la misma bandeja que ve cada local.
 */
@Injectable()
export class SuperAdminOverviewService {
  private readonly logger = new Logger(SuperAdminOverviewService.name);
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

  async overview(now: Date = new Date()): Promise<SuperAdminOverview> {
    const today = madridTodayWindow(now);
    const week = madridRecentDaysWindow(now, WEEK_PAST_DAYS);
    const envHoldDays = resolveHoldDays(null, this.config.get('PAYOUT_HOLD_DAYS'));

    const { venues, charges, earnings, debts, wallets, fees } = await this.prisma.acrossVenues(async (tx) => ({
      venues: await tx.$queryRaw<VenueRow[]>`
        SELECT v.id, v.name, v.slug, v."businessId", b.name AS "businessName", b.status::text AS "businessStatus",
               v."pausedAt", v."payoutHoldDays", v."serviceFeeEnabled"
          FROM venues v
          LEFT JOIN businesses b ON b.id = v."businessId"
         WHERE v."deletedAt" IS NULL
         ORDER BY b.name NULLS LAST, v.name
      `,
      charges: await tx.$queryRaw<ChargeRow[]>`
        SELECT p."tenantId",
               COUNT(*) FILTER (WHERE ${paymentAt('p')} >= ${today.from})::int AS "paymentsToday",
               COALESCE(SUM(p."amountCents" + p."serviceFeeCents" + p."tipCents") FILTER (WHERE ${paymentAt('p')} >= ${today.from}), 0)::bigint AS "chargedToday",
               COALESCE(SUM(p."amountCents" + p."serviceFeeCents" + p."tipCents"), 0)::bigint AS "chargedWeek"
          FROM payments p
         WHERE p.status IN ${PAID_STATUSES_SQL}
           AND ${paymentAt('p')} >= ${week.from} AND ${paymentAt('p')} < ${now}
         GROUP BY p."tenantId"
      `,
      // Lo no pagado y lo que sigue en espera, con el corte de CADA local (sus
      // días o PAYOUT_HOLD_DAYS), en horas exactas como payoutCutoff.
      earnings: await tx.$queryRaw<EarningRow[]>`
        SELECT e."tenantId", e."operatorId",
               SUM(e."commissionCents" + COALESCE(e."tipCents", 0) - e."reversedCents")::bigint AS "unpaidCents",
               COALESCE(SUM(e."commissionCents" + COALESCE(e."tipCents", 0) - e."reversedCents")
                 FILTER (WHERE e."createdAt" > ${now}::timestamptz
                                - make_interval(hours => 24 * COALESCE(v."payoutHoldDays", ${envHoldDays}::int))), 0)::bigint AS "heldCents"
          FROM operator_earnings e
          JOIN venues v ON v.id = e."tenantId"
         WHERE e."payoutId" IS NULL
         GROUP BY e."tenantId", e."operatorId"
      `,
      debts: await tx.$queryRaw<DebtRow[]>`
        SELECT e."tenantId", e."operatorId", SUM(r."reversedDeltaCents")::bigint AS "debtCents"
          FROM earning_reversals r
          JOIN operator_earnings e ON e.id = r."earningId"
         WHERE r."afterPayout" AND r."settledPayoutId" IS NULL
         GROUP BY e."tenantId", e."operatorId"
      `,
      // client_wallets tiene FORCE RLS: por eso todo va con acrossVenues (bypass).
      wallets: await tx.$queryRaw<WalletRow[]>`
        SELECT "tenantId", COUNT(*) FILTER (WHERE "balanceCents" > 0)::int AS wallets,
               COALESCE(SUM("balanceCents"), 0)::bigint AS balance
          FROM client_wallets
         WHERE status = 'ACTIVE'
         GROUP BY "tenantId"
      `,
      // «Comisión del servicio» de la semana: la de los cobros pagados con
      // tarjeta o datáfono y la de las recargas en efectivo, menos la devuelta.
      fees: await tx.$queryRaw<FeeRow[]>`
        SELECT x."tenantId", COALESCE(SUM(x.cents), 0)::bigint AS "feeWeek"
          FROM (
            SELECT p."tenantId", p."serviceFeeCents" AS cents
              FROM payments p
             WHERE p.status IN ${PAID_STATUSES_SQL} AND p."serviceFeeCents" <> 0
               AND ${paymentAt('p')} >= ${week.from} AND ${paymentAt('p')} < ${now}
            UNION ALL
            SELECT ct."tenantId", ct."serviceFeeCents"
              FROM wallet_cash_topups ct
             WHERE ct."serviceFeeCents" <> 0 AND ct."createdAt" >= ${week.from} AND ct."createdAt" < ${now}
            UNION ALL
            SELECT r."tenantId", -r."serviceFeeCents"
              FROM refunds r
             WHERE r.status = 'SUCCEEDED' AND r."serviceFeeCents" <> 0
               AND ${refundAt('r')} >= ${week.from} AND ${refundAt('r')} < ${now}
          ) x
         GROUP BY x."tenantId"
      `,
    }));

    const openIncidents = await this.incidentCounts(venues.map((v) => v.id), now);
    const balances = operatorBalancesByVenue(earnings, debts);
    const chargeBy = new Map(charges.map((c) => [c.tenantId, c]));
    const walletBy = new Map(wallets.map((w) => [w.tenantId, w]));
    const feeBy = new Map((fees ?? []).map((f) => [f.tenantId, Number(f.feeWeek ?? 0)]));

    const venueViews: Array<OverviewVenue & { businessName: string | null; businessStatus: VenueRow['businessStatus'] }> =
      venues.map((v) => {
        const pausedBy = venuePauseScope({ pausedAt: v.pausedAt, business: v.businessStatus ? { status: v.businessStatus } : null });
        const c = chargeBy.get(v.id);
        const w = walletBy.get(v.id);
        const payable = payableSummary(balances.get(v.id) ?? []);
        return {
          venueId: v.id,
          name: v.name,
          slug: v.slug,
          businessId: v.businessId,
          businessName: v.businessName,
          businessStatus: v.businessStatus,
          paused: pausedBy !== null,
          pausedBy,
          chargedTodayCents: Number(c?.chargedToday ?? 0),
          paymentsToday: Number(c?.paymentsToday ?? 0),
          chargedWeekCents: Number(c?.chargedWeek ?? 0),
          pendingToChicasCents: payable.payableCents,
          heldForChicasCents: payable.heldCents,
          chicasDebtCents: payable.debtCents,
          liveCustomerBalanceCents: Number(w?.balance ?? 0),
          liveCustomerWallets: Number(w?.wallets ?? 0),
          openIncidents: openIncidents.get(v.id) ?? 0,
          payoutHoldDays: resolveHoldDays(v.payoutHoldDays, this.config.get('PAYOUT_HOLD_DAYS')),
          serviceFeeEnabled: v.serviceFeeEnabled ?? false,
          serviceFeeWeekCents: feeBy.get(v.id) ?? 0,
        };
      });

    const groups = new Map<string, OverviewBusiness>();
    for (const v of venueViews) {
      const key = v.businessId ?? '';
      const group =
        groups.get(key) ??
        ({ businessId: v.businessId, name: v.businessName ?? NO_BUSINESS, status: v.businessStatus, totals: emptyTotals(), venues: [] } as OverviewBusiness);
      const { businessName: _n, businessStatus: _s, ...venue } = v;
      group.venues.push(venue);
      group.totals = addVenue(group.totals, venue);
      groups.set(key, group);
    }
    const businesses = [...groups.values()];
    return {
      generatedAt: now.toISOString(),
      todayFrom: today.from.toISOString(),
      weekFrom: week.from.toISOString(),
      totals: venueViews.reduce<OverviewTotals>((t, v) => addVenue(t, v), emptyTotals()),
      businesses,
    };
  }

  /** Incidencias abiertas por local (la misma bandeja del panel), pocos locales a la vez. */
  private async incidentCounts(venueIds: string[], now: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < venueIds.length; i += INCIDENT_CONCURRENCY) {
      const batch = venueIds.slice(i, i + INCIDENT_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((id) => this.incidents.list(id, now)));
      results.forEach((r, j) => {
        const id = batch[j]!;
        if (r.status === 'fulfilled') out.set(id, r.value.length);
        else this.logger.warn(`Vista general: no se pudieron contar las incidencias de ${id}: ${(r.reason as Error).message}`);
      });
    }
    return out;
  }
}

/** Por local, el saldo de cada chica (no pagado, en espera, deuda) como Tesorería. */
export function operatorBalancesByVenue(
  earnings: ReadonlyArray<EarningRow>,
  debts: ReadonlyArray<DebtRow>,
): Map<string, BalanceSums[]> {
  const byOperator = new Map<string, { tenantId: string; sums: BalanceSums }>();
  const slot = (tenantId: string, operatorId: string) => {
    const key = `${tenantId}:${operatorId}`;
    const found = byOperator.get(key) ?? { tenantId, sums: { unpaidCents: 0, heldCents: 0, debtCents: 0 } };
    byOperator.set(key, found);
    return found.sums;
  };
  for (const e of earnings) {
    const s = slot(e.tenantId, e.operatorId);
    s.unpaidCents += Number(e.unpaidCents);
    s.heldCents += Number(e.heldCents);
  }
  for (const d of debts) slot(d.tenantId, d.operatorId).debtCents += Number(d.debtCents);
  const out = new Map<string, BalanceSums[]>();
  for (const { tenantId, sums } of byOperator.values()) out.set(tenantId, [...(out.get(tenantId) ?? []), sums]);
  return out;
}

function emptyTotals(): OverviewTotals {
  return {
    chargedTodayCents: 0,
    paymentsToday: 0,
    chargedWeekCents: 0,
    pendingToChicasCents: 0,
    heldForChicasCents: 0,
    chicasDebtCents: 0,
    liveCustomerBalanceCents: 0,
    liveCustomerWallets: 0,
    openIncidents: 0,
    venues: 0,
    pausedVenues: 0,
    serviceFeeWeekCents: 0,
  };
}

function addVenue(t: OverviewTotals, v: OverviewVenue): OverviewTotals {
  return {
    chargedTodayCents: t.chargedTodayCents + v.chargedTodayCents,
    paymentsToday: t.paymentsToday + v.paymentsToday,
    chargedWeekCents: t.chargedWeekCents + v.chargedWeekCents,
    pendingToChicasCents: t.pendingToChicasCents + v.pendingToChicasCents,
    heldForChicasCents: t.heldForChicasCents + v.heldForChicasCents,
    chicasDebtCents: t.chicasDebtCents + v.chicasDebtCents,
    liveCustomerBalanceCents: t.liveCustomerBalanceCents + v.liveCustomerBalanceCents,
    liveCustomerWallets: t.liveCustomerWallets + v.liveCustomerWallets,
    openIncidents: t.openIncidents + v.openIncidents,
    venues: t.venues + 1,
    pausedVenues: t.pausedVenues + (v.paused ? 1 : 0),
    serviceFeeWeekCents: (t.serviceFeeWeekCents ?? 0) + (v.serviceFeeWeekCents ?? 0),
  };
}
