import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Prisma } from '@nightpay/db';
import {
  normalizeContactPhone,
  paymentMethodsOf,
  type CreateReservationDto,
  type ReservationPackageView,
  type ReservationPayKind,
  type ReservationView,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import type { PayLanguage } from '../payments/customer-lang';
import { VENUE_PAUSE_SELECT, venuePauseScope } from '../venues/venue-pause';
import { reservationPaymentKey } from './reservation-payment-key';
import {
  LIVE_STATUSES,
  PENDING_HOLD_MS,
  bookableNightProblem,
  clientCancelProblem,
  clientChangeBlocker,
  clientChangeProblem,
  dateOfDay,
  dayOf,
  isManageToken,
  isPromoterCode,
  isReservationsCode,
  moneyParts,
  newGuestToken,
  newManageToken,
  newReservationRef,
  payAmount,
  payableKinds,
} from './reservation-rules';
import { RESERVATION_VIEW_INCLUDE, packageView, reservationView, type ReservationRow } from './reservation-views';
import { loseDeposit, venueOwnerId } from './reservation-wallet';
import { CLIENT_BITCOIN_CONFIRMING, bitcoinConfirming, conflictCode } from './reservation-open-payments';
import { BITCOIN_CONFIRMING_CODE } from '../payments/payments.service';

/** Desde dónde se reserva: el enlace del local, el de un RRPP o el panel. */
export interface BookingEntry {
  venueId: string;
  venueName: string;
  /** Hora de apertura (minutos desde las 00:00): las 48 h y el «hasta 2 h antes». */
  openMinute: number;
  source: 'WEB' | 'RRPP' | 'PANEL';
  promoter: { id: string; bps: number } | null;
  packages: ReservationPackageView[];
  /** null: se puede reservar; si no, por qué no (en pausa, sin pago con tarjeta…). */
  problem: string | null;
}

/** La página del grupo (la de quien reservó). */
export interface GroupView {
  venueName: string;
  /** Hora de apertura del local (minutos desde las 00:00): «Añadir a mi calendario». */
  openMinute: number;
  reservation: ReservationView;
  payable: ReservationPayKind[];
  /** El pago a medias (para volver a él). */
  openPayUrl: string | null;
  canChangeDate: boolean;
  /** «Cancelar» (sin pagar) o «Anular» (pagada, con 48 h: pierde la señal); null: no puede. */
  cancel: 'Cancelar' | 'Anular' | null;
  /** Por qué no puede anular (pagada y sin las 48 h). */
  cancelBlocked: string | null;
  /** El enlace al saldo del grupo: después de llegar, o si le queda tras «No vino», anular él o anular el local. */
  saldoHref: string | null;
  guestTokens: Array<{ seq: number; token: string }>;
}

/** La página del QR de una persona del grupo. */
export interface GuestPageView {
  venueName: string;
  token: string;
  seq: number;
  entries: number;
  packageName: string;
  nightDate: string;
  status: string;
  statusText: string;
  kind: 'ITEMS' | 'CREDIT';
  balanceCents: number | null;
  itemsLeft: ReservationView['itemsLeft'];
  mySpentCents: number;
}

/** El candado de «Pagar» de una reserva (dos toques a la vez: un solo cobro). */
const PAY_LOCK_TTL_S = 20;
const MAX_REF_ATTEMPTS = 4;
export const RESERVATION_GONE = 'Este enlace no existe o ya no vale';

/**
 * Un pago de la reserva sin empezar: CREATED o, tras cerrarse su factura de
 * bitcoin sin pagarse («Pagar de otra forma» o caducada), AWAITING_CAPTURE. Se
 * puede seguir pagando o cancelar para abrir otro.
 */
export const NOT_STARTED = ['CREATED', 'AWAITING_CAPTURE'] as const;
const notStarted = (status: string): boolean => (NOT_STARTED as readonly string[]).includes(status);

/**
 * Al anular la reserva se cancelan sus pagos a medias sin empezar o con su
 * factura de bitcoin abierta (PaymentsService.reservationPaymentCancelable).
 * Con la tarjeta ya en el banco, no: lo resuelve el banco.
 */
const OPEN_TO_CANCEL: Prisma.PaymentWhereInput = { OR: [{ status: { in: [...NOT_STARTED] } }, { status: 'AUTHORIZING', provider: 'BTCPAY' }] };

interface OpenReservationPayment {
  paymentId: string;
  kind: string;
  status: string;
  qrToken: string;
  provider: string | null;
}

/**
 * Se puede volver a él desde la página del grupo («Seguir pagando»): sin
 * empezar, o pagando con su factura de bitcoin abierta (su página con el QR).
 * En el banco con tarjeta, no: se espera a que conteste.
 */
export function continuable(open: Pick<OpenReservationPayment, 'status' | 'provider'>): boolean {
  return notStarted(open.status) || (open.status === 'AUTHORIZING' && open.provider === 'BTCPAY');
}

/**
 * Reservados con señal (la parte del cliente): la entrada (el enlace del local
 * o el de un RRPP), reservar, pagar con tarjeta (señal, resto o todo: un cobro
 * de recarga del saldo del grupo, la maquinaria de /r y /pay, sin bitcoin), la
 * página del grupo, la de cada QR y el cambio de fecha (una vez, con 48 h).
 * Lo pagado lo apunta el aviso del banco (reservation-ledger), nunca esto.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ─── La entrada ─────────────────────────────────────────────────────

  /** El enlace público del local (/reservar/<código>), si está encendido. */
  async entryByVenueCode(code: string): Promise<BookingEntry | null> {
    if (!isReservationsCode(code)) return null;
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { reservationsCode: code }, select: { id: true, reservationsEnabled: true, deletedAt: true } }),
    );
    if (!venue || !venue.reservationsEnabled || venue.deletedAt) return null;
    return this.entryFor(venue.id, 'WEB', null);
  }

  /** El enlace de un RRPP (/rp/<código>), si está activo. */
  async entryByPromoterCode(code: string): Promise<BookingEntry | null> {
    if (!isPromoterCode(code)) return null;
    const promoter = await this.prisma.asSystem((tx) =>
      tx.promoter.findUnique({ where: { code }, select: { id: true, tenantId: true, active: true, commissionBps: true, user: { select: { deletedAt: true } } } }),
    );
    if (!promoter || !promoter.active || promoter.user.deletedAt) return null;
    return this.entryFor(promoter.tenantId, 'RRPP', { id: promoter.id, bps: promoter.commissionBps });
  }

  /** La entrada del panel (el dueño o el encargado reservan para un cliente). */
  async entryForPanel(venueId: string): Promise<BookingEntry> {
    const entry = await this.entryFor(venueId, 'PANEL', null);
    if (!entry) throw new NotFoundException('Local no encontrado');
    return entry;
  }

  private async entryFor(venueId: string, source: BookingEntry['source'], promoter: BookingEntry['promoter']): Promise<BookingEntry | null> {
    return this.prisma.asSystem(async (tx) => {
      const venue = await tx.venue.findUnique({
        where: { id: venueId },
        select: { id: true, name: true, deletedAt: true, paymentMethods: true, reservationsOpenMinute: true, ...VENUE_PAUSE_SELECT },
      });
      if (!venue || venue.deletedAt) return null;
      const packages = await tx.reservationPackage.findMany({
        where: { tenantId: venueId, active: true },
        orderBy: [{ priceCents: 'asc' }, { name: 'asc' }],
      });
      return {
        venueId,
        venueName: venue.name,
        openMinute: venue.reservationsOpenMinute,
        source,
        promoter,
        packages: packages.map(packageView),
        problem: await this.venueProblem(tx, venue),
      };
    });
  }

  /** ¿Se puede cobrar con tarjeta una reserva aquí? (en pausa, tarjeta o saldo apagados, sin pasarela o sin terminal) */
  private async venueProblem(
    tx: TransactionalClient,
    venue: { id: string; paymentMethods: unknown } & Parameters<typeof venuePauseScope>[0],
  ): Promise<string | null> {
    if (venuePauseScope(venue)) return 'El local está cerrado ahora mismo';
    const methods = paymentMethodsOf(venue.paymentMethods);
    if (!methods.card || !methods.wallet) return 'Ahora no se puede reservar desde aquí';
    const gateways = await tx.gatewayCredential.count({ where: { tenantId: venue.id, active: true } });
    const terminal = await tx.terminal.count({ where: { tenantId: venue.id, active: true } });
    return gateways > 0 && terminal > 0 ? null : 'Ahora no se puede reservar desde aquí';
  }

  // ─── Reservar ───────────────────────────────────────────────────────

  /**
   * Crea la reserva (sin pagar): la copia del paquete, la señal (30 %), un QR
   * por persona y «vendido por». La misma `key` dos veces: la misma reserva.
   * Con tope por noche, las reservas pagadas y las recién hechas sin pagar.
   */
  async book(entry: BookingEntry, dto: CreateReservationDto, soldByUserId: string | null = null): Promise<{ id: string; ref: string; manageToken: string }> {
    if (entry.problem) throw new ConflictException({ message: entry.problem, code: 'RESERVATIONS_UNAVAILABLE' });
    const replay = await this.byCreateKey(entry.venueId, dto.key);
    if (replay) return replay;
    const problem = bookableNightProblem(dto.nightDate, new Date(), entry.openMinute);
    if (problem) throw new BadRequestException({ message: problem, code: 'RESERVATION_DATE' });
    const phone = normalizeContactPhone(dto.customerPhone);
    if (!phone) throw new BadRequestException({ message: 'Ese teléfono no parece bueno', code: 'RESERVATION_PHONE' });
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.insertReservation(entry, dto, phone, soldByUserId);
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        const raced = await this.byCreateKey(entry.venueId, dto.key);
        if (raced) return raced;
        if (attempt >= MAX_REF_ATTEMPTS) throw err;
      }
    }
  }

  private async byCreateKey(venueId: string, key: string): Promise<{ id: string; ref: string; manageToken: string } | null> {
    return this.prisma.asSystem((tx) =>
      tx.reservation.findUnique({ where: { tenantId_createKey: { tenantId: venueId, createKey: key } }, select: { id: true, ref: true, manageToken: true } }),
    );
  }

  private async insertReservation(
    entry: BookingEntry,
    dto: CreateReservationDto,
    phone: string,
    soldByUserId: string | null,
  ): Promise<{ id: string; ref: string; manageToken: string }> {
    const created = await this.prisma.asSystem(async (tx) => {
      const pkg = await tx.reservationPackage.findFirst({ where: { id: dto.packageId, tenantId: entry.venueId, active: true } });
      if (!pkg) throw new NotFoundException({ message: 'Ese paquete ya no está disponible', code: 'RESERVATION_PACKAGE' });
      await this.assertRoom(tx, entry.venueId, pkg, dto.nightDate);
      const money = moneyParts(pkg.priceCents);
      return tx.reservation.create({
        data: {
          tenantId: entry.venueId,
          ref: newReservationRef(),
          createKey: dto.key,
          packageId: pkg.id,
          packageName: pkg.name,
          kind: pkg.kind,
          priceCents: pkg.priceCents,
          creditCents: pkg.creditCents,
          depositCents: money.depositCents,
          entries: pkg.entries,
          items: pkg.items ?? [],
          nightDate: dateOfDay(dto.nightDate),
          customerName: dto.customerName,
          customerPhone: phone,
          notes: dto.notes ?? null,
          source: entry.source,
          promoterId: entry.promoter?.id ?? null,
          promoterBps: entry.promoter?.bps ?? null,
          soldByUserId,
          manageToken: newManageToken(),
          guests: {
            create: Array.from({ length: pkg.entries }, (_, i) => ({ tenantId: entry.venueId, seq: i + 1, qrToken: newGuestToken() })),
          },
        },
        select: { id: true, ref: true, manageToken: true },
      });
    });
    await this.audit.log({
      action: 'reservation.created',
      tenantId: entry.venueId,
      ...(soldByUserId ? { actorId: soldByUserId } : {}),
      targetType: 'Reservation',
      targetId: created.id,
      payload: { ref: created.ref, packageId: dto.packageId, nightDate: dto.nightDate, source: entry.source, promoterId: entry.promoter?.id ?? null },
    });
    return created;
  }

  /** Tope por noche del paquete (con candado: dos reservas a la vez no pasan del tope). */
  async assertRoom(tx: TransactionalClient, venueId: string, pkg: { id: string; maxPerNight: number | null }, nightDate: string, exceptId?: string): Promise<void> {
    if (pkg.maxPerNight === null) return;
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`resv-room:${pkg.id}:${nightDate}`}))`;
    const taken = await tx.reservation.count({
      where: {
        tenantId: venueId,
        packageId: pkg.id,
        nightDate: dateOfDay(nightDate),
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ status: { in: [...LIVE_STATUSES] } }, { status: 'PENDING', createdAt: { gt: new Date(Date.now() - PENDING_HOLD_MS) } }],
      },
    });
    if (taken >= pkg.maxPerNight) {
      throw new ConflictException({ message: 'Esa noche ya no quedan reservados de este paquete: elige otra', code: 'RESERVATION_FULL' });
    }
  }

  // ─── Pagar ──────────────────────────────────────────────────────────

  /** «Pagar la señal», «Pagar todo» o «Pagar el resto» desde la página del grupo. */
  async startPayment(manageToken: string, kind: ReservationPayKind, lang: PayLanguage): Promise<{ payUrl: string; payToken: string }> {
    const r = await this.byManageToken(manageToken);
    if (!r) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
    return this.startFor(r.id, kind, lang);
  }

  /**
   * Abre el cobro con tarjeta (o devuelve el que ya está a medias de ese tipo).
   * Uno a la vez por reserva: candado en Redis (sin Redis, 503).
   */
  async startFor(reservationId: string, kind: ReservationPayKind, lang: PayLanguage): Promise<{ payUrl: string; payToken: string }> {
    const lock = `resv:pay:${reservationId}`;
    let locked = false;
    try {
      locked = (await this.redis.set(lock, '1', 'EX', PAY_LOCK_TTL_S, 'NX')) === 'OK';
    } catch (err) {
      this.logger.warn(`Reserva sin Redis (no se abre el pago): ${(err as Error).message}`);
      throw new ServiceUnavailableException({ message: 'Ahora no se puede pagar: inténtalo en unos minutos.', code: 'TRY_LATER' });
    }
    if (!locked) throw new ConflictException({ message: 'Ya estamos preparando el pago: espera unos segundos.', code: 'RESERVATION_PAY_BUSY' });
    try {
      const token = await this.openPayment(reservationId, kind);
      return { payToken: token, payUrl: `/pay/${encodeURIComponent(token)}?lang=${lang}` };
    } finally {
      await this.redis.del(lock).catch(() => undefined);
    }
  }

  private async openPayment(reservationId: string, kind: ReservationPayKind): Promise<string> {
    const r = await this.prisma.asSystem((tx) => tx.reservation.findUnique({ where: { id: reservationId } }));
    if (!r) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
    const open = await this.openPaymentOf(r.id);
    // El mismo pago a medias: sin empezar (o de vuelta tras cerrar su factura de bitcoin) o con su factura de bitcoin abierta.
    if (open?.kind === kind && continuable(open)) return open.qrToken;
    if (open) await this.dropOpen(open, r.tenantId);
    const amountCents = payAmount(r, kind);
    if (amountCents === null) throw new ConflictException({ message: 'Ese pago ya no toca en esta reserva', code: 'RESERVATION_NOT_PAYABLE' });
    if (kind === 'REST' && !r.walletId) throw new ConflictException({ message: 'Ese pago ya no toca en esta reserva', code: 'RESERVATION_NOT_PAYABLE' });
    const attempt = r.payAttempts + 1;
    await this.prisma.asSystem((tx) => tx.reservation.update({ where: { id: r.id }, data: { payAttempts: attempt } }));
    const terminal = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({ where: { tenantId: r.tenantId, active: true }, orderBy: [{ reception: 'asc' }, { externalId: 'asc' }], select: { externalId: true } }),
    );
    if (!terminal) throw new ConflictException({ message: 'Ahora no se puede pagar desde aquí', code: 'RESERVATIONS_UNAVAILABLE' });
    const created = await this.payments.create(r.tenantId, reservationPaymentKey(r.id, kind, attempt), {
      amountCents,
      currency: 'EUR',
      terminalExternalId: terminal.externalId,
      wallet: r.walletId ? { walletId: r.walletId } : { create: true, identifier: `Reservado ${r.ref}` },
    });
    await this.prisma.asSystem((tx) =>
      tx.reservationPayment.create({ data: { tenantId: r.tenantId, reservationId: r.id, paymentId: created.id, kind, amountCents } }),
    );
    this.logger.log(`Reserva ${r.ref}: pago ${kind} ${amountCents}c abierto (payment=${created.id})`);
    return created.qrToken;
  }

  /**
   * El pago a medias de la reserva: sin pagar y sin caducar (también de vuelta
   * a AWAITING_CAPTURE al cerrarse su factura de bitcoin sin pagar), o pagando
   * (en el banco o con su factura de bitcoin abierta).
   */
  private async openPaymentOf(reservationId: string): Promise<OpenReservationPayment | null> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.reservationPayment.findMany({
        where: {
          reservationId,
          paidAt: null,
          payment: { OR: [{ status: 'AUTHORIZING' }, { status: { in: [...NOT_STARTED] }, qrExpiresAt: { gt: new Date() } }] },
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { paymentId: true, kind: true, payment: { select: { status: true, qrToken: true, provider: true } } },
      }),
    );
    const row = rows[0];
    return row?.paymentId && row.payment
      ? { paymentId: row.paymentId, kind: row.kind, status: row.payment.status, qrToken: row.payment.qrToken, provider: row.payment.provider }
      : null;
  }

  /**
   * Otro tipo de pago con uno a medias: el de antes se cancela (si ya está en el
   * banco o con bitcoin, hay que esperar). Con el cobro bloqueado: si entretanto
   * fue al banco no se toca, y si abrió una factura de bitcoin se cierra.
   */
  private async dropOpen(open: { paymentId: string; status: string }, tenantId: string): Promise<void> {
    if (notStarted(open.status)) {
      const canceled = await this.payments
        .cancelReservationPayment(open.paymentId, tenantId, { reason: 'Otro pago del reservado' })
        .catch((err: unknown) => {
          if (conflictCode(err) === BITCOIN_CONFIRMING_CODE) return false;
          throw err;
        });
      if (canceled) return;
      // Se pagó, caducó o fue al banco mientras tanto: hay que esperar.
    }
    throw new ConflictException({ message: 'Tienes un pago a medias: termínalo o espera unos minutos.', code: 'RESERVATION_PAY_OPEN' });
  }

  /**
   * Al anular la reserva (el local o el cliente), antes de anularla: sus pagos a
   * medias (sin empezar o con su factura de bitcoin abierta) se cancelan como
   * «Cancelar cobro» y su factura de bitcoin se cierra. Con el bitcoin ya en la
   * red, 409 BITCOIN_CONFIRMING (con `confirmingMessage`) y la reserva no se
   * anula: el dinero llegaría igual. Con la tarjeta ya en el banco no se tocan.
   */
  async cancelOpenPayments(
    reservationId: string,
    tenantId: string,
    opts: { reason: string; byUserId?: string; confirmingMessage: string },
  ): Promise<void> {
    for (const paymentId of await this.openToCancel(reservationId)) {
      try {
        await this.payments.cancelReservationPayment(paymentId, tenantId, { reason: opts.reason, ...(opts.byUserId ? { byUserId: opts.byUserId } : {}) });
      } catch (err) {
        if (conflictCode(err) === BITCOIN_CONFIRMING_CODE) throw bitcoinConfirming(opts.confirmingMessage);
        throw err;
      }
    }
  }

  /**
   * Ya anulada: un pago a medias que se abrió entretanto (otra pestaña) también
   * se cancela. Sin frenar nada: lo que no se pueda cancelar, si llega a pagarse,
   * queda apuntado en la reserva como no aplicado.
   */
  async cancelLeftoverPayments(reservationId: string, tenantId: string, reason: string, byUserId?: string): Promise<void> {
    for (const paymentId of await this.openToCancel(reservationId)) {
      await this.payments
        .cancelReservationPayment(paymentId, tenantId, { reason, ...(byUserId ? { byUserId } : {}) })
        .catch((err: unknown) => this.logger.warn(`Reserva ${reservationId} anulada: el pago ${paymentId} no se pudo cancelar: ${(err as Error).message}`));
    }
  }

  private async openToCancel(reservationId: string): Promise<string[]> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.reservationPayment.findMany({ where: { reservationId, paidAt: null, payment: OPEN_TO_CANCEL }, select: { paymentId: true } }),
    );
    return rows.flatMap((r) => (r.paymentId ? [r.paymentId] : []));
  }

  // ─── La página del grupo y la de cada QR ────────────────────────────

  async byManageToken(token: string): Promise<{ id: string; tenantId: string } | null> {
    if (!isManageToken(token)) return null;
    return this.prisma.asSystem((tx) => tx.reservation.findUnique({ where: { manageToken: token }, select: { id: true, tenantId: true } }));
  }

  async groupView(manageToken: string, now: Date = new Date()): Promise<GroupView | null> {
    if (!isManageToken(manageToken)) return null;
    const row = await this.prisma.asSystem((tx) =>
      tx.reservation.findUnique({
        where: { manageToken },
        include: { ...RESERVATION_VIEW_INCLUDE, venue: { select: { name: true, reservationsOpenMinute: true } } },
      }),
    );
    if (!row) return null;
    const view = reservationView(row as unknown as ReservationRow);
    const open = await this.openPaymentOf(row.id);
    const openMinute = row.venue.reservationsOpenMinute;
    const day = dayOf(row.nightDate);
    const cancelBlocked = clientCancelProblem({ status: row.status, nightDate: day }, now, openMinute);
    // Con saldo para otra noche: lo que sobró, lo que quedó tras perder la señal o lo pagado si anuló el local.
    const leftover = ['ARRIVED', 'NO_SHOW', 'CLIENT_CANCELED', 'CANCELED'].includes(row.status);
    const saldo = row.wallet && leftover && row.wallet.balanceCents > 0 ? row.wallet.qrToken : null;
    const payable = payableKinds(row);
    return {
      venueName: row.venue.name,
      openMinute,
      reservation: view,
      payable,
      // «Seguir pagando», solo mientras la reserva se pueda pagar (anulada o ya pagada, nunca).
      openPayUrl: open && continuable(open) && payable.length > 0 ? `/pay/${encodeURIComponent(open.qrToken)}` : null,
      canChangeDate: clientChangeBlocker({ ...row, nightDate: day }, now, openMinute) === null,
      cancel: cancelBlocked ? null : row.status === 'PENDING' ? 'Cancelar' : 'Anular',
      cancelBlocked: row.status === 'DEPOSIT_PAID' || row.status === 'PAID' ? cancelBlocked : null,
      saldoHref: saldo ? `/w/${encodeURIComponent(saldo)}` : null,
      guestTokens: row.guests.map((g) => ({ seq: g.seq, token: g.qrToken })),
    };
  }

  async guestView(guestToken: string): Promise<GuestPageView | null> {
    if (!/^[A-Za-z0-9_-]{24}$/.test(guestToken)) return null;
    const guest = await this.prisma.asSystem((tx) =>
      tx.reservationGuest.findUnique({
        where: { qrToken: guestToken },
        include: { reservation: { include: { ...RESERVATION_VIEW_INCLUDE, venue: { select: { name: true } } } } },
      }),
    );
    if (!guest) return null;
    const r = guest.reservation;
    const view = reservationView(r as unknown as ReservationRow);
    return {
      venueName: r.venue.name,
      token: guestToken,
      seq: guest.seq,
      entries: r.entries,
      packageName: r.packageName,
      nightDate: view.nightDate,
      status: r.status,
      statusText: view.statusText,
      kind: view.kind,
      balanceCents: r.status === 'ARRIVED' ? view.balanceCents : null,
      itemsLeft: view.itemsLeft,
      mySpentCents: view.guests.find((g) => g.id === guest.id)?.spentCents ?? 0,
    };
  }

  /** El cliente cambia la fecha: una sola vez, con la reserva pagada y avisando con 48 h. */
  async changeDate(manageToken: string, nightDate: string): Promise<void> {
    const ref = await this.byManageToken(manageToken);
    if (!ref) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
    await this.prisma.asSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM reservations WHERE id = ${ref.id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
      const r = await tx.reservation.findUniqueOrThrow({
        where: { id: ref.id },
        include: { package: { select: { id: true, maxPerNight: true } }, venue: { select: { reservationsOpenMinute: true } } },
      });
      const problem = clientChangeProblem({ ...r, nightDate: dayOf(r.nightDate) }, nightDate, new Date(), r.venue.reservationsOpenMinute);
      if (problem) throw new ConflictException({ message: problem, code: 'RESERVATION_CHANGE' });
      await this.assertRoom(tx, r.tenantId, r.package, nightDate, r.id);
      await tx.reservation.update({
        where: { id: r.id },
        data: { nightDate: dateOfDay(nightDate), previousNightDate: r.nightDate, dateChangedAt: new Date() },
      });
      await this.audit.logInTx(tx, {
        action: 'reservation.date_changed',
        tenantId: r.tenantId,
        targetType: 'Reservation',
        targetId: r.id,
        payload: { by: 'client', from: dayOf(r.nightDate), to: nightDate },
      });
    });
  }

  /**
   * El cliente anula su reserva. Sin pagar: «Cancelar» (nada que devolver).
   * Pagada y avisando con 48 h antes de la apertura: pierde la señal (pasa a
   * venta, como «No vino», firmado por el dueño del local) y lo demás le queda
   * de saldo para otra noche, sin devolución en dinero. Sin las 48 h no puede
   * (si no viene, «No vino»). En los dos casos, su pago a medias se cancela
   * antes (y su factura de bitcoin se cierra); con su bitcoin ya en la red, 409
   * BITCOIN_CONFIRMING y no se anula (llegaría igual).
   */
  async clientCancel(manageToken: string): Promise<void> {
    const ref = await this.byManageToken(manageToken);
    if (!ref) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
    // ¿Se puede anular? Antes de tocar sus pagos (se mira otra vez con la reserva bloqueada).
    await this.prisma.asSystem((tx) => this.clientCancelable(tx, ref.id));
    const reason = 'Reserva cancelada por el cliente';
    await this.cancelOpenPayments(ref.id, ref.tenantId, { reason, confirmingMessage: CLIENT_BITCOIN_CONFIRMING });
    await this.prisma.asSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM reservations WHERE id = ${ref.id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
      const r = await this.clientCancelable(tx, ref.id);
      if (r.status === 'PENDING') {
        await tx.reservation.update({ where: { id: r.id }, data: { status: 'CANCELED', canceledAt: new Date(), cancelReason: 'El cliente la canceló sin pagar' } });
        await this.audit.logInTx(tx, { action: 'reservation.canceled_by_client', tenantId: r.tenantId, targetType: 'Reservation', targetId: r.id, payload: { paidCents: 0 } });
        return;
      }
      const outcome = await loseDeposit(tx, r, await venueOwnerId(tx, r.tenantId), 'cancel');
      await tx.reservation.update({
        where: { id: r.id },
        data: { status: 'CLIENT_CANCELED', canceledAt: new Date(), cancelReason: 'Anulada por el cliente con 48 h', recognizedAt: new Date() },
      });
      await this.audit.logInTx(tx, { action: 'reservation.canceled_by_client', tenantId: r.tenantId, targetType: 'Reservation', targetId: r.id, payload: { ...outcome } });
    });
    await this.cancelLeftoverPayments(ref.id, ref.tenantId, reason);
  }

  /** La reserva, si el cliente la puede anular ahora; si no, 409 con el porqué. */
  private async clientCancelable(tx: TransactionalClient, id: string) {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { venue: { select: { reservationsOpenMinute: true } } } });
    const problem = clientCancelProblem({ status: r.status, nightDate: dayOf(r.nightDate) }, new Date(), r.venue.reservationsOpenMinute);
    if (problem) throw new ConflictException({ message: problem, code: 'RESERVATION_CANCEL' });
    return r;
  }
}
