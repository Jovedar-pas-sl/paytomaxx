import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { serviceFeeQuote, type ReservationCashQuote, type ReservationView } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { CashTopUpService } from '../wallets/wallet-cash-topup.service';
import { applyReservationCash, voidPromoterCommission } from './reservation-ledger';
import {
  arrivalProblem,
  arrivalSaleCents,
  bookableNightProblem,
  dateOfDay,
  dayOf,
  guestTokenFrom,
  itemsLeft,
  itemsOf,
  autoNoShowAt,
  nightOf,
  noShowProblem,
} from './reservation-rules';
import { RESERVATION_VIEW_INCLUDE, reservationView, servedItems, type ReservationRow } from './reservation-views';
import { loseDeposit, spendFromGroupWallet, venueOwnerId } from './reservation-wallet';
import { REST_PAYING_TEXT, RESERVATION_PAY_OPEN_CODE, conflictCode, restPayingText } from './reservation-open-payments';
import { NOT_STARTED, ReservationsService } from './reservations.service';

export interface StaffActor {
  userId: string;
  role: string;
  tenantId: string;
}

const MANAGERS = new Set(['OWNER', 'MANAGER']);
const NOT_FOUND = 'Reserva no encontrada';
/** Un pago de la reserva a medias: sin empezar o pagándose (en el banco o con bitcoin). */
const PAYING = ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING'] as const;

/**
 * Reservados (la parte del local): la lista de la noche, la mesa, la puerta
 * (leer el QR y dar la llegada; el resto con tarjeta), la barra (gastar del
 * paquete con el QR de una persona), «No vino», y el local que cambia la fecha
 * o anula. Todo con la reserva bloqueada y en el local de quien lo hace.
 */
@Injectable()
export class ReservationOpsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(CashTopUpService) private readonly cash: CashTopUpService,
  ) {}

  // ─── Leer ──────────────────────────────────────────────────────────

  /** Las reservas de una noche (por defecto, la de ahora). */
  async night(actor: StaffActor, nightDate?: string): Promise<ReservationView[]> {
    const day = nightDate ?? nightOf(new Date());
    if (bookableNightProblem(day, new Date()) === 'Esa fecha no vale') throw new BadRequestException('Esa fecha no vale');
    return this.list(actor.tenantId, { nightDate: dateOfDay(day) });
  }

  /** Noches ya pasadas con reservas pagadas sin llegada: para marcar «No vino». */
  async overdue(actor: StaffActor): Promise<ReservationView[]> {
    return this.list(actor.tenantId, { nightDate: { lt: dateOfDay(nightOf(new Date())) }, status: { in: ['DEPOSIT_PAID', 'PAID'] } });
  }

  async detail(actor: StaffActor, id: string): Promise<ReservationView> {
    const rows = await this.list(actor.tenantId, { id });
    if (!rows[0]) throw new NotFoundException(NOT_FOUND);
    return rows[0];
  }

  /** La puerta o la barra leen el QR de una persona: su reserva y quién es. */
  async byGuest(actor: StaffActor, raw: string): Promise<{ reservation: ReservationView; guest: { id: string; seq: number } }> {
    const guest = await this.guestOf(actor, raw);
    return { reservation: await this.detail(actor, guest.reservationId), guest: { id: guest.id, seq: guest.seq } };
  }

  private async list(tenantId: string, where: Prisma.ReservationWhereInput): Promise<ReservationView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reservation.findMany({ where: { tenantId, ...where }, include: RESERVATION_VIEW_INCLUDE, orderBy: [{ nightDate: 'asc' }, { createdAt: 'asc' }] }),
    );
    const panelIds = [...new Set(rows.flatMap((r) => (r.soldByUserId ? [r.soldByUserId] : [])))];
    const users = panelIds.length
      ? await this.prisma.withTenant(tenantId, (tx) => tx.user.findMany({ where: { id: { in: panelIds } }, select: { id: true, displayName: true, email: true } }))
      : [];
    const nameOf = (id: string | null) => {
      const u = users.find((x) => x.id === id);
      return u ? (u.displayName ?? u.email) : null;
    };
    return rows.map((r) => reservationView(r as unknown as ReservationRow, nameOf(r.soldByUserId)));
  }

  private async guestOf(actor: StaffActor, raw: string): Promise<{ id: string; seq: number; reservationId: string }> {
    const token = guestTokenFrom(raw);
    if (!token) throw new BadRequestException({ message: 'Ese QR no es de un reservado', code: 'RESERVATION_QR' });
    const guest = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.reservationGuest.findFirst({ where: { qrToken: token, tenantId: actor.tenantId }, select: { id: true, seq: true, reservationId: true } }),
    );
    if (!guest) throw new NotFoundException({ message: 'Ese QR no es de un reservado de este local', code: 'RESERVATION_QR' });
    return guest;
  }

  // ─── La mesa y la puerta ───────────────────────────────────────────

  /** El local asigna la mesa. */
  async setTable(actor: StaffActor, id: string, tableLabel: string | null): Promise<ReservationView> {
    await this.locked(actor, id, async (tx, r) => {
      await tx.reservation.update({ where: { id: r.id }, data: { tableLabel: tableLabel || null } });
    });
    return this.detail(actor, id);
  }

  /**
   * «Dar la llegada» (pagado entero y en su noche): lo que no es para consumir
   * pasa a venta (un consumo del saldo del grupo) y el resto queda como saldo
   * del grupo. Ya llegados: solo apunta que esta persona ha entrado.
   */
  async arrive(actor: StaffActor, id: string, guestId?: string): Promise<ReservationView> {
    await this.locked(actor, id, async (tx, r) => {
      if (r.status !== 'ARRIVED') {
        // El encargado puede apuntar tarde la llegada de una noche pasada (p. ej. tras deshacer «No vino»).
        const problem = arrivalProblem({ ...r, nightDate: dayOf(r.nightDate) }, new Date(), MANAGERS.has(actor.role));
        if (problem) throw new ConflictException({ message: problem, code: 'RESERVATION_ARRIVAL' });
        const saleCents = arrivalSaleCents(r);
        if (saleCents > 0) {
          await spendFromGroupWallet(tx, {
            tenantId: r.tenantId,
            walletId: this.walletOf(r),
            amountCents: saleCents,
            providedByUserId: actor.userId,
            category: 'VENUE_ENTRY',
            notes: `Reservado ${r.ref}: ${r.packageName}`,
            idempotencyKey: `resv-arrive:${r.id}`,
          });
        }
        await tx.reservation.update({
          where: { id: r.id },
          data: { status: 'ARRIVED', arrivedAt: new Date(), arrivedByUserId: actor.userId, recognizedAt: new Date() },
        });
        await this.audit.logInTx(tx, { action: 'reservation.arrived', tenantId: r.tenantId, actorId: actor.userId, targetType: 'Reservation', targetId: r.id, payload: { saleCents } });
      }
      if (guestId) await tx.reservationGuest.updateMany({ where: { id: guestId, reservationId: r.id, checkedInAt: null }, data: { checkedInAt: new Date() } });
    });
    return this.detail(actor, id);
  }

  /** «Cobrar el resto» en la puerta: el cobro con tarjeta del 70 % (el cliente lo paga con su móvil). */
  async collectRest(actor: StaffActor, id: string): Promise<{ payUrl: string; payToken: string }> {
    await this.detail(actor, id);
    return this.reservations.startFor(id, 'REST', 'es');
  }

  /**
   * «No vino» (encargado o dueño, cuando acaba su noche): la señal no se
   * devuelve (pasa a venta) y, si pagó todo, el 70 % queda como saldo para
   * otra noche (sin devolución en dinero).
   */
  async noShow(actor: StaffActor, id: string): Promise<ReservationView> {
    this.assertManager(actor);
    await this.locked(actor, id, async (tx, r) => {
      const problem = noShowProblem({ ...r, nightDate: dayOf(r.nightDate) }, new Date());
      if (problem) throw new ConflictException({ message: problem, code: 'RESERVATION_NO_SHOW' });
      const outcome = await loseDeposit(tx, r, actor.userId, 'noshow');
      await tx.reservation.update({ where: { id: r.id }, data: { status: 'NO_SHOW', noShowAt: new Date(), noShowAuto: false, recognizedAt: new Date() } });
      await this.audit.logInTx(tx, { action: 'reservation.no_show', tenantId: r.tenantId, actorId: actor.userId, targetType: 'Reservation', targetId: r.id, payload: { ...outcome } });
    });
    return this.detail(actor, id);
  }

  /**
   * «No vino» solo: a las 12:00 de Madrid del día siguiente, las reservas
   * pagadas cuyo grupo no ha llegado (lo firma el dueño del local). Una a una,
   * con la reserva bloqueada: dos réplicas a la vez no lo hacen dos veces.
   */
  async autoNoShowDue(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.asSystem((tx) =>
      tx.reservation.findMany({
        where: { status: { in: ['DEPOSIT_PAID', 'PAID'] }, nightDate: { lt: dateOfDay(nightOf(now)) } },
        select: { id: true, tenantId: true, nightDate: true },
        take: 200,
      }),
    );
    let marked = 0;
    for (const d of due.filter((x) => autoNoShowAt(dayOf(x.nightDate)).getTime() <= now.getTime())) {
      const done = await this.prisma.withTenant(d.tenantId, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM reservations WHERE id = ${d.id}::uuid FOR UPDATE`;
        if (rows[0]?.status !== 'DEPOSIT_PAID' && rows[0]?.status !== 'PAID') return false;
        const r = await tx.reservation.findUniqueOrThrow({ where: { id: d.id } });
        const outcome = await loseDeposit(tx, r, await venueOwnerId(tx, r.tenantId), 'noshow');
        await tx.reservation.update({ where: { id: r.id }, data: { status: 'NO_SHOW', noShowAt: now, noShowAuto: true, recognizedAt: now } });
        await this.audit.logInTx(tx, { action: 'reservation.no_show', tenantId: r.tenantId, targetType: 'Reservation', targetId: r.id, payload: { ...outcome, auto: true } });
        return true;
      });
      if (done) marked += 1;
    }
    return marked;
  }

  /**
   * Deshacer «No vino» (encargado o dueño): la señal vuelve al saldo del grupo
   * (se anula su consumo) y la reserva queda como estaba (pagada). Si vinieron,
   * después se apunta la llegada.
   */
  async undoNoShow(actor: StaffActor, id: string): Promise<ReservationView> {
    this.assertManager(actor);
    await this.locked(actor, id, async (tx, r) => {
      if (r.status !== 'NO_SHOW') throw new ConflictException({ message: 'Esta reserva no está como «No vino»', code: 'RESERVATION_NO_SHOW' });
      const lost = r.walletId
        ? await tx.walletConsumption.findFirst({
            where: { tenantId: r.tenantId, walletId: r.walletId, idempotencyKey: { startsWith: `resv-noshow:${r.id}:` }, reversedAt: null },
            select: { id: true, amountCents: true },
          })
        : null;
      if (lost && r.walletId) {
        await tx.walletConsumption.update({ where: { id: lost.id }, data: { reversedAt: new Date(), reversedByUserId: actor.userId } });
        await tx.$executeRaw`
          UPDATE client_wallets SET "balanceCents" = "balanceCents" + ${lost.amountCents}::int, status = 'ACTIVE'::"WalletStatus", "updatedAt" = now()
           WHERE id = ${r.walletId}::uuid
        `;
      }
      await tx.reservation.update({
        where: { id: r.id },
        data: { status: r.paidCents >= r.priceCents ? 'PAID' : 'DEPOSIT_PAID', noShowAt: null, noShowAuto: false, recognizedAt: null },
      });
      await this.audit.logInTx(tx, {
        action: 'reservation.no_show_undone',
        tenantId: r.tenantId,
        actorId: actor.userId,
        targetType: 'Reservation',
        targetId: r.id,
        payload: { restoredCents: lost?.amountCents ?? 0 },
      });
    });
    return this.detail(actor, id);
  }

  // ─── El resto en efectivo (puerta o recepción) ─────────────────────

  /**
   * Cuánto se cobra en efectivo del resto (con la comisión del servicio de las
   * recargas) y si se puede: con el resto pagándose aún con bitcoin en la red o
   * con el cliente en su banco (los 2 minutos), no (lo que diría «Cancelar cobro»).
   */
  async cashQuote(actor: StaffActor, id: string): Promise<ReservationCashQuote> {
    const r = await this.detail(actor, id);
    const venue = await this.prisma.venue.findUnique({ where: { id: actor.tenantId }, select: VENUE_SERVICE_FEE_SELECT });
    const pending = r.status === 'DEPOSIT_PAID' ? r.pendingCents : 0;
    const fee = pending > 0 ? serviceFeeQuote(venueServiceFeeOf(venue), 'topUp', pending).feeCents : 0;
    const blocked =
      pending <= 0
        ? 'Este reservado no tiene el resto pendiente'
        : ((await this.restPayingBlocker(actor.tenantId, id)) ??
          (await this.cash.cashBlockedReason(actor.tenantId, { userId: actor.userId, role: actor.role })));
    return { amountCents: pending, serviceFeeCents: fee, totalCents: pending + fee, blocked };
  }

  /**
   * El resto en efectivo: una recarga en efectivo del saldo del grupo (la de
   * recepción: entra en la caja de la noche y en el cierre a ciegas, con sus
   * permisos y su tope legal) y, con ella, la reserva pagada entera.
   * Repetir con la misma `key` no cobra dos veces. Si el resto se estaba pagando
   * con tarjeta o con bitcoin, ese pago se cancela antes (como «Cancelar cobro»);
   * si no se puede (bitcoin en la red, el cliente en su banco), 409 y no se cobra.
   */
  async payRestCash(actor: StaffActor, id: string, input: { key: string; serviceFeeCents: number }): Promise<ReservationView> {
    const r = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.reservation.findFirst({ where: { id, tenantId: actor.tenantId }, include: { wallet: { select: { shortCode: true } } } }),
    );
    if (!r) throw new NotFoundException(NOT_FOUND);
    if (await this.cashDone(actor.tenantId, input.key)) return this.detail(actor, id);
    const pending = r.priceCents - r.paidCents;
    const code = r.wallet?.shortCode;
    if (r.status !== 'DEPOSIT_PAID' || pending <= 0 || !code) {
      throw new ConflictException({ message: 'Este reservado no tiene el resto pendiente', code: 'RESERVATION_NOT_PAYABLE' });
    }
    // Para no cobrar el resto dos veces: el pago del resto a medias (tarjeta o bitcoin), cancelado antes.
    await this.cancelRestPaying(actor, r.id);
    // Por si se pagó mientras tanto: la reserva tiene que seguir igual.
    const still = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.reservation.findFirst({ where: { id, tenantId: actor.tenantId }, select: { status: true, priceCents: true, paidCents: true } }),
    );
    if (!still || still.status !== 'DEPOSIT_PAID' || still.priceCents - still.paidCents !== pending) {
      throw new ConflictException({ message: 'Este reservado no tiene el resto pendiente', code: 'RESERVATION_NOT_PAYABLE' });
    }
    const top = await this.cash.topUp(actor.tenantId, { userId: actor.userId, role: actor.role }, {
      amountCents: pending,
      idempotencyKey: `resv-cash:${input.key}`,
      wallet: { code },
      serviceFeeCents: input.serviceFeeCents,
    });
    await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const link = await tx.reservationPayment.findUnique({ where: { cashTopUpId: top.topUpId }, select: { id: true } });
      if (link) return;
      const created = await tx.reservationPayment.create({
        data: { tenantId: actor.tenantId, reservationId: r.id, cashTopUpId: top.topUpId, kind: 'REST', amountCents: pending },
        select: { id: true },
      });
      await applyReservationCash(tx, {
        tenantId: actor.tenantId,
        linkId: created.id,
        reservationId: r.id,
        amountCents: pending,
        walletId: top.walletId,
        cashTopUpId: top.topUpId,
      });
    });
    return this.detail(actor, id);
  }

  private async cashDone(tenantId: string, key: string): Promise<boolean> {
    const n = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reservationPayment.count({ where: { tenantId, cashTopUp: { idempotencyKey: `resv-cash:${key}` } } }),
    );
    return n > 0;
  }

  /** Los pagos de la reserva a medias (con tarjeta o bitcoin): sin pagar, sin empezar o pagándose. */
  private async payingOf(tenantId: string, reservationId: string): Promise<string[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.reservationPayment.findMany({
        where: { tenantId, reservationId, paidAt: null, payment: { status: { in: [...PAYING] } } },
        select: { paymentId: true },
      }),
    );
    return rows.flatMap((x) => (x.paymentId ? [x.paymentId] : []));
  }

  /** Por qué no se cobra ahora el resto en efectivo: su pago a medias no se puede cancelar todavía (null: sí). */
  private async restPayingBlocker(tenantId: string, reservationId: string): Promise<string | null> {
    for (const paymentId of await this.payingOf(tenantId, reservationId)) {
      const blocker = await this.payments.cancelBlocker(paymentId, tenantId);
      if (blocker) return restPayingText(blocker) ?? REST_PAYING_TEXT;
    }
    return null;
  }

  /**
   * El resto en efectivo con su pago con tarjeta o bitcoin a medias: se cancela
   * como «Cancelar cobro» (quién y con qué móvil; con bitcoin, la factura se
   * cierra). Con el bitcoin en la red o el cliente en su banco (2 minutos), 409
   * RESERVATION_PAY_OPEN: no se cobra en efectivo.
   */
  private async cancelRestPaying(actor: StaffActor, reservationId: string): Promise<void> {
    for (const paymentId of await this.payingOf(actor.tenantId, reservationId)) {
      try {
        await this.payments.cancel(paymentId, { userId: actor.userId, role: actor.role, tenantId: actor.tenantId });
      } catch (err) {
        const text = restPayingText(err);
        if (text) throw new ConflictException({ code: RESERVATION_PAY_OPEN_CODE, message: text });
        // Pagado o cerrado entretanto (el 409 sin código): lo dice la reserva, que se mira otra vez después.
        if (err instanceof ConflictException && conflictCode(err) === null) continue;
        throw err;
      }
    }
  }

  // ─── El local cambia la fecha o anula ──────────────────────────────

  /** El local ofrece otra fecha (no gasta el cambio del cliente). */
  async venueChangeDate(actor: StaffActor, id: string, nightDate: string): Promise<ReservationView> {
    this.assertManager(actor);
    await this.locked(actor, id, async (tx, r) => {
      if (!['PENDING', 'DEPOSIT_PAID', 'PAID'].includes(r.status)) throw new ConflictException({ message: 'Esta reserva ya no se puede cambiar', code: 'RESERVATION_CHANGE' });
      const venue = await tx.venue.findUniqueOrThrow({ where: { id: r.tenantId }, select: { reservationsOpenMinute: true } });
      const problem = bookableNightProblem(nightDate, new Date(), venue.reservationsOpenMinute);
      if (problem) throw new BadRequestException({ message: problem, code: 'RESERVATION_DATE' });
      const pkg = await tx.reservationPackage.findUniqueOrThrow({ where: { id: r.packageId }, select: { id: true, maxPerNight: true } });
      await this.reservations.assertRoom(tx, r.tenantId, pkg, nightDate, r.id);
      await tx.reservation.update({ where: { id: r.id }, data: { nightDate: dateOfDay(nightDate), previousNightDate: r.nightDate } });
      // El local cambia la fecha: el RRPP pierde la comisión (siempre).
      await voidPromoterCommission(tx, r, actor.userId);
      await this.audit.logInTx(tx, {
        action: 'reservation.date_changed',
        tenantId: r.tenantId,
        actorId: actor.userId,
        targetType: 'Reservation',
        targetId: r.id,
        payload: { by: 'venue', from: dayOf(r.nightDate), to: nightDate },
      });
    });
    return this.detail(actor, id);
  }

  /**
   * El local anula la reserva. Sin pagar: «Cancelar». Pagada: el dinero está en
   * el saldo del grupo y se devuelve desde Saldos → «Devolver saldo» (el saldo
   * de una reserva anulada por el local sí se devuelve).
   */
  async venueCancel(actor: StaffActor, id: string, reason: string): Promise<{ reservation: ReservationView; refundCents: number; walletId: string | null }> {
    this.assertManager(actor);
    let open: string | null = null;
    const out = await this.locked(actor, id, async (tx, r) => {
      if (!['PENDING', 'DEPOSIT_PAID', 'PAID'].includes(r.status)) throw new ConflictException({ message: 'Esta reserva ya no se puede anular', code: 'RESERVATION_CANCEL' });
      await tx.reservation.update({ where: { id: r.id }, data: { status: 'CANCELED', canceledAt: new Date(), canceledByUserId: actor.userId, cancelReason: reason } });
      // Anula el local: el RRPP pierde la comisión (si ya estaba apuntada, sale del reparto).
      await voidPromoterCommission(tx, r, actor.userId);
      const pending = await tx.reservationPayment.findFirst({ where: { reservationId: r.id, paidAt: null, payment: { status: { in: [...NOT_STARTED] } } }, select: { paymentId: true } });
      open = pending?.paymentId ?? null;
      await this.audit.logInTx(tx, { action: 'reservation.canceled_by_venue', tenantId: r.tenantId, actorId: actor.userId, targetType: 'Reservation', targetId: r.id, payload: { reason, paidCents: r.paidCents } });
      return { refundCents: r.paidCents, walletId: r.walletId };
    });
    if (open) await this.payments.transition(open, { type: 'CANCELED', reason: 'Reserva anulada por el local' }, actor.tenantId).catch(() => undefined);
    return { reservation: await this.detail(actor, id), ...out };
  }

  // ─── La barra ──────────────────────────────────────────────────────

  /** Paquete de importe: cobrar del saldo del grupo con el QR de una persona. */
  async charge(actor: StaffActor, input: { guestToken: string; amountCents: number; key: string }): Promise<ReservationView> {
    const guest = await this.guestOf(actor, input.guestToken);
    if (await this.spendDone(actor.tenantId, input.key)) return this.detail(actor, guest.reservationId);
    await this.locked(actor, guest.reservationId, async (tx, r) => {
      this.assertSpendable(r, 'CREDIT');
      const consumptionId = await spendFromGroupWallet(tx, {
        tenantId: r.tenantId,
        walletId: this.walletOf(r),
        amountCents: input.amountCents,
        providedByUserId: actor.userId,
        category: 'VENUE_BAR',
        notes: `Reservado ${r.ref} · persona ${guest.seq}`,
        idempotencyKey: `resv-spend:${input.key}`,
      });
      await tx.reservationSpend.create({
        data: { tenantId: r.tenantId, reservationId: r.id, guestId: guest.id, kind: 'AMOUNT', amountCents: input.amountCents, consumptionId, providedByUserId: actor.userId, idempotencyKey: input.key },
      });
    }).catch(async (err: unknown) => {
      if (isUniqueClash(err) && (await this.spendDone(actor.tenantId, input.key))) return;
      throw err;
    });
    return this.detail(actor, guest.reservationId);
  }

  /** Paquete de cosas fijas: servir una cosa del paquete con el QR de una persona. */
  async serve(actor: StaffActor, input: { guestToken: string; itemName: string; qty: number; key: string }): Promise<ReservationView> {
    const guest = await this.guestOf(actor, input.guestToken);
    if (await this.spendDone(actor.tenantId, input.key)) return this.detail(actor, guest.reservationId);
    await this.locked(actor, guest.reservationId, async (tx, r) => {
      this.assertSpendable(r, 'ITEMS');
      const spends = await tx.reservationSpend.findMany({ where: { reservationId: r.id }, select: { guestId: true, kind: true, itemName: true, qty: true, amountCents: true } });
      const line = itemsLeft(itemsOf(r.items), servedItems(spends)).find((i) => i.name === input.itemName);
      if (!line) throw new BadRequestException({ message: 'Eso no está en el paquete', code: 'RESERVATION_ITEM' });
      if (line.left < input.qty) throw new ConflictException({ message: `Del paquete quedan ${line.left}`, code: 'RESERVATION_ITEM_LEFT' });
      await tx.reservationSpend.create({
        data: { tenantId: r.tenantId, reservationId: r.id, guestId: guest.id, kind: 'ITEM', itemName: input.itemName, qty: input.qty, providedByUserId: actor.userId, idempotencyKey: input.key },
      });
    }).catch(async (err: unknown) => {
      if (isUniqueClash(err) && (await this.spendDone(actor.tenantId, input.key))) return;
      throw err;
    });
    return this.detail(actor, guest.reservationId);
  }

  private assertSpendable(r: { status: string; kind: string }, kind: 'ITEMS' | 'CREDIT'): void {
    if (r.status !== 'ARRIVED') throw new ConflictException({ message: 'Primero hay que dar la llegada en la puerta', code: 'RESERVATION_NOT_ARRIVED' });
    if (r.kind !== kind) {
      throw new ConflictException({
        message: kind === 'CREDIT' ? 'Este paquete es de cosas fijas: sirve las cosas del paquete' : 'Este paquete es de importe: cobra el importe',
        code: 'RESERVATION_KIND',
      });
    }
  }

  private async spendDone(tenantId: string, key: string): Promise<boolean> {
    const n = await this.prisma.withTenant(tenantId, (tx) => tx.reservationSpend.count({ where: { tenantId, idempotencyKey: key } }));
    return n > 0;
  }

  // ─── Auxiliares ────────────────────────────────────────────────────

  private assertManager(actor: StaffActor): void {
    if (!MANAGERS.has(actor.role)) throw new ForbiddenException('Solo el encargado o el dueño');
  }

  private walletOf(r: { walletId: string | null }): string {
    if (!r.walletId) throw new ConflictException({ message: 'Esta reserva aún no tiene saldo', code: 'RESERVATION_WALLET' });
    return r.walletId;
  }

  /** La reserva del local de quien lo hace, bloqueada, en una transacción con su local. */
  private async locked<T>(
    actor: StaffActor,
    id: string,
    fn: (tx: TransactionalClient, r: Prisma.ReservationGetPayload<object>) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withTenant(actor.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM reservations WHERE id = ${id}::uuid AND "tenantId" = ${actor.tenantId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) throw new NotFoundException(NOT_FOUND);
      const r = await tx.reservation.findUniqueOrThrow({ where: { id } });
      return fn(tx, r);
    });
  }
}

function isUniqueClash(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
