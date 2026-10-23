import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { StaffFicha } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PAYEE_ROLES } from '../operators/payee-roles';
import { PAID_STATUSES_SQL, afterPayoutDebt, linesJson, paymentAt, refundAt } from '../reports/reporting-sql';
import { peopleById } from './cobros.service';
import { MoneyMapService } from './money-map.service';
import { staffFichaRow, staffRates, staffReversalRow, staffStats, type EarningFeedRow, type ReversalFeedRow } from './staff-ficha';

/** Filas de la ficha (una noche de un local con mucho movimiento cabe de sobra). */
const MAX_ROWS = 300;
const LAST_PAYOUTS = 3;

type RawEarning = Omit<EarningFeedRow, 'chargedBy'> & { chargedById: string | null };
type RawReversal = Omit<ReversalFeedRow, 'chargedBy'> & { chargedById: string | null };

/**
 * Ficha de la chica (y del camarero) en el panel, maqueta 9.2:
 *   GET /v1/admin/operators/:id/ficha
 * Esta noche (la misma ventana que el mapa del dinero en directo): cada cobro
 * en el que le toca algo, con su referencia, sección, cómo pagó y su parte;
 * lo vendido, lo suyo y lo pagado; lo que le toca de cada cosa y sus últimos
 * pagos. Lo suyo cuadra con el mapa del dinero (y el Z): lo que ya debe de un
 * cobro que se le pagó antes de devolverlo y, la noche de la devolución, lo
 * que se le resta por devolver un cobro de otra noche (una fila más). SQL con
 * el local explícito (FORCE RLS: dentro de withTenant).
 */
@Injectable()
export class StaffFichaService {
  private readonly prisma: PrismaService;
  private readonly moneyMap: MoneyMapService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(MoneyMapService) moneyMap: MoneyMapService) {
    this.prisma = prisma;
    this.moneyMap = moneyMap;
  }

  async ficha(tenantId: string, personId: string, now: Date = new Date()): Promise<StaffFicha> {
    const [person, venue] = await this.prisma.asSystem((tx) =>
      Promise.all([
        tx.user.findFirst({
          where: { id: personId, tenantId, role: { in: [...PAYEE_ROLES] } },
          select: { id: true, displayName: true, email: true, role: true, commissionBps: true },
        }),
        tx.venue.findUnique({ where: { id: tenantId }, select: { operatorCommissionDefaults: true, invitationRules: true } }),
      ]),
    );
    if (!person || !venue) throw new NotFoundException('No es del personal de este local');
    const window = await this.moneyMap.currentWindow(tenantId, now);

    const { raw, reversals, paid, payouts } = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<RawEarning[]>`
        SELECT e.id,
               COALESCE(${paymentAt('p')}, c."createdAt") AS at,
               e."commissionCents", COALESCE(e."tipCents", 0) AS "tipCents", e."reversedCents",
               ${afterPayoutDebt('e')}::int AS "debtCents",
               e."paymentAmountCents", e."paymentLineId", e."paymentId",
               COALESCE(p.ref, w.ref) AS ref,
               COALESCE(p."amountCents", c."amountCents") AS "chargeAmountCents",
               COALESCE(p."tipCents", c."tipCents", 0) AS "chargeTipCents",
               COALESCE(p."revenueCategory", c.category) AS category,
               COALESCE(p."serviceName", w."serviceName", c.notes) AS "serviceName",
               p."captureMethod", p."posOperationNumber", a."payMethod" AS "approvedPayMethod",
               p."authorizedAt", p.status::text AS "paymentStatus",
               c."authMethod", c."reversedAt",
               cw."shortCode" AS "walletCode",
               COALESCE(pl.lines, wl.lines) AS lines,
               il.category AS "invitationCategory",
               COALESCE(p."createdByUserId", c."providedByUserId") AS "chargedById"
          FROM operator_earnings e
          LEFT JOIN payments p ON p.id = e."paymentId"
          LEFT JOIN wallet_consumptions c ON c.id = e."consumptionId"
          LEFT JOIN wallet_charge_requests w ON w."consumptionId" = c.id
          LEFT JOIN client_wallets cw ON cw.id = c."walletId"
          LEFT JOIN payment_lines il ON il.id = e."paymentLineId"
          LEFT JOIN LATERAL (
            SELECT pa."payMethod" FROM payment_attempts pa
             WHERE pa."paymentId" = p.id AND pa.status = 'APPROVED'
             ORDER BY pa."createdAt" ASC LIMIT 1
          ) a ON true
          LEFT JOIN LATERAL (SELECT ${linesJson('l')} AS lines FROM payment_lines l WHERE l."paymentId" = p.id) pl ON true
          LEFT JOIN LATERAL (SELECT ${linesJson('l')} AS lines FROM payment_lines l WHERE l."walletChargeId" = w.id) wl ON true
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."operatorId" = ${personId}::uuid
           AND (
             (p.id IS NOT NULL AND p."walletId" IS NULL AND p.status IN ${PAID_STATUSES_SQL}
                AND ${paymentAt('p')} >= ${window.from} AND ${paymentAt('p')} < ${window.to})
             OR (c.id IS NOT NULL AND c."createdAt" >= ${window.from} AND c."createdAt" < ${window.to})
           )
         ORDER BY at DESC, e.id DESC
         LIMIT ${MAX_ROWS}
      `;
      // Las devoluciones de la ventana de sus cobros de otras noches (el mismo
      // filtro que el mapa del dinero): de los de esta ventana ya resta su fila.
      const earlier = await tx.$queryRaw<RawReversal[]>`
        SELECT er.id,
               ${refundAt('r')} AS at,
               ${paymentAt('p')} AS "chargedAt",
               er."reversedDeltaCents", r."amountCents" AS "refundAmountCents",
               e."paymentLineId", p.ref, p."amountCents" AS "chargeAmountCents",
               p."revenueCategory" AS category, p."captureMethod", p."posOperationNumber",
               a."payMethod" AS "approvedPayMethod", p."authorizedAt",
               pl.lines, il.category AS "invitationCategory",
               p."createdByUserId" AS "chargedById"
          FROM earning_reversals er
          JOIN refunds r ON r.id = er."refundId"
          JOIN operator_earnings e ON e.id = er."earningId"
          JOIN payments p ON p.id = e."paymentId"
          LEFT JOIN payment_lines il ON il.id = e."paymentLineId"
          LEFT JOIN LATERAL (
            SELECT pa."payMethod" FROM payment_attempts pa
             WHERE pa."paymentId" = p.id AND pa.status = 'APPROVED'
             ORDER BY pa."createdAt" ASC LIMIT 1
          ) a ON true
          LEFT JOIN LATERAL (SELECT ${linesJson('l')} AS lines FROM payment_lines l WHERE l."paymentId" = p.id) pl ON true
         WHERE r."tenantId" = ${tenantId}::uuid
           AND e."operatorId" = ${personId}::uuid
           AND r.status = 'SUCCEEDED'
           AND er."reversedDeltaCents" > 0
           AND ${refundAt('r')} >= ${window.from} AND ${refundAt('r')} < ${window.to}
           AND NOT (
             p."walletId" IS NULL AND p.status IN ${PAID_STATUSES_SQL}
             AND ${paymentAt('p')} >= ${window.from} AND ${paymentAt('p')} < ${window.to}
           )
         ORDER BY at DESC, er.id DESC
         LIMIT ${MAX_ROWS}
      `;
      const [tonight] = await tx.$queryRaw<Array<{ cents: bigint | number | null }>>`
        SELECT COALESCE(SUM(po."totalCents"), 0)::bigint AS cents
          FROM operator_payouts po
         WHERE po."tenantId" = ${tenantId}::uuid AND po."operatorId" = ${personId}::uuid
           AND po."createdAt" >= ${window.from} AND po."createdAt" < ${window.to}
      `;
      const last = await tx.operatorPayout.findMany({
        where: { tenantId, operatorId: personId },
        orderBy: { createdAt: 'desc' },
        take: LAST_PAYOUTS,
        select: { id: true, createdAt: true, totalCents: true, externalRail: true },
      });
      return { raw: rows, reversals: earlier, paid: Number(tonight?.cents ?? 0), payouts: last };
    });

    const chargers = [...raw, ...reversals].flatMap((r) => (r.chargedById ? [r.chargedById] : []));
    const people = await this.prisma.asSystem((tx) => peopleById(tx, chargers));
    const by = (id: string | null) => (id ? (people.get(id) ?? null) : null);
    const rows = [
      ...raw.map(({ chargedById, ...r }) => staffFichaRow({ ...r, chargedBy: by(chargedById) } as EarningFeedRow, person.id)),
      ...reversals.map(({ chargedById, ...r }) => staffReversalRow({ ...r, chargedBy: by(chargedById) } as ReversalFeedRow, person.id)),
    ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const role = person.role === 'WAITER' ? 'WAITER' : 'OPERATOR';
    return {
      person: { id: person.id, name: person.displayName?.trim() || person.email, role },
      window: { from: window.from.toISOString(), to: window.to.toISOString(), nightId: window.nightId, open: window.open },
      stats: staffStats(rows, paid),
      rates: staffRates({
        role,
        commissionBps: person.commissionBps,
        defaults: (venue.operatorCommissionDefaults ?? null) as Partial<Record<string, number>> | null,
        invitationRules: venue.invitationRules,
      }),
      rows,
      payouts: payouts.map((p) => ({ id: p.id, at: p.createdAt.toISOString(), cents: p.totalCents, rail: p.externalRail })),
    };
  }
}
