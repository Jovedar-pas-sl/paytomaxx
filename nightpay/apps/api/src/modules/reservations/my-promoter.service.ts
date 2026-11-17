import { Inject, Injectable } from '@nestjs/common';
import { RESERVATION_STATUS_TEXT, type MyPromoterReservation, type MyPromoterView, type ReservationStatus } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReservationCatalogService } from './reservation-catalog.service';
import type { StaffActor } from './reservation-ops.service';
import { dateOfDay, dayOf, nightOf, promoterCommissionCents } from './reservation-rules';

/** Las que vienen y las pasadas más recientes: una noche no tiene tantas de un RRPP. */
const UPCOMING_MAX = 100;
const RECENT_MAX = 30;

/** Solo lo que se enseña: nunca customerName, customerPhone, notes ni manageToken. */
const ROW_SELECT = {
  ref: true,
  nightDate: true,
  packageName: true,
  entries: true,
  status: true,
  priceCents: true,
  paidCents: true,
  promoterBps: true,
  commissionEarnedAt: true,
  commissionVoidedAt: true,
} as const;

export interface MyPromoterRow {
  ref: string;
  nightDate: Date;
  packageName: string;
  entries: number;
  status: string;
  priceCents: number;
  paidCents: number;
  promoterBps: number | null;
  commissionEarnedAt: Date | null;
  commissionVoidedAt: Date | null;
}

/** Aún se puede pagar (y falta): sin pagar o con la señal. */
const PAYABLE = new Set(['PENDING', 'DEPOSIT_PAID']);

export function myPromoterReservation(r: MyPromoterRow): MyPromoterReservation {
  const status = r.status as ReservationStatus;
  const open = PAYABLE.has(r.status);
  return {
    ref: r.ref,
    nightDate: dayOf(r.nightDate),
    packageName: r.packageName,
    entries: r.entries,
    status,
    statusText: RESERVATION_STATUS_TEXT[status] ?? r.status,
    priceCents: r.priceCents,
    paidCents: r.paidCents,
    pendingCents: open ? Math.max(0, r.priceCents - r.paidCents) : 0,
    commissionCents: promoterCommissionCents(r.priceCents, r.promoterBps ?? 0),
    commission: r.commissionVoidedAt ? 'NONE' : r.commissionEarnedAt ? 'EARNED' : open ? 'EXPECTED' : 'NONE',
  };
}

/**
 * «Tus reservas de RRPP» (app del personal): lo de quien entra, en su local
 * (el de la sesión, con RLS). Su comisión sale de sus ganancias de siempre
 * (operator_earnings) en los cobros de SUS reservas: ganada, por cobrar (sin
 * pagar en «Pagos a compañeras») y cobrada. null: no es RRPP (o de baja).
 */
@Injectable()
export class MyPromoterService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReservationCatalogService) private readonly catalog: ReservationCatalogService,
  ) {}

  async forUser(actor: StaffActor): Promise<MyPromoterView | null> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const promoter = await tx.promoter.findFirst({
        where: { tenantId: actor.tenantId, userId: actor.userId, active: true },
        select: { id: true, code: true, commissionBps: true },
      });
      if (!promoter) return null;
      const tonight = dateOfDay(nightOf(new Date()));
      const mine = { tenantId: actor.tenantId, promoterId: promoter.id };
      const upcoming = await tx.reservation.findMany({
        where: { ...mine, nightDate: { gte: tonight } },
        orderBy: [{ nightDate: 'asc' }, { createdAt: 'asc' }],
        take: UPCOMING_MAX,
        select: ROW_SELECT,
      });
      const recent = await tx.reservation.findMany({
        where: { ...mine, nightDate: { lt: tonight } },
        orderBy: [{ nightDate: 'desc' }, { createdAt: 'desc' }],
        take: RECENT_MAX,
        select: ROW_SELECT,
      });
      // Sus ganancias en los cobros de sus reservas (como al quitarle la comisión: reservation-ledger).
      const [sums] = await tx.$queryRaw<Array<{ earned: number; toPay: number }>>`
        SELECT COALESCE(SUM(e."commissionCents" + e."tipCents" - e."reversedCents"), 0)::int AS earned,
               COALESCE(SUM(e."commissionCents" + e."tipCents" - e."reversedCents") FILTER (WHERE e."payoutId" IS NULL), 0)::int AS "toPay"
          FROM operator_earnings e
         WHERE e."tenantId" = ${actor.tenantId}::uuid
           AND e."operatorId" = ${actor.userId}::uuid
           AND e."paymentId" IN (
                 SELECT rp."paymentId" FROM reservation_payments rp
                   JOIN reservations r ON r.id = rp."reservationId"
                  WHERE r."tenantId" = ${actor.tenantId}::uuid AND r."promoterId" = ${promoter.id}::uuid AND rp."paymentId" IS NOT NULL)
      `;
      const earned = sums?.earned ?? 0;
      const toPay = sums?.toPay ?? 0;
      return {
        url: `${this.catalog.origin}/reservar/${promoter.code}`,
        commissionBps: promoter.commissionBps,
        earnedCents: earned,
        toPayCents: toPay,
        paidCents: earned - toPay,
        upcoming: upcoming.map(myPromoterReservation),
        recent: recent.map(myPromoterReservation),
      };
    });
  }
}
