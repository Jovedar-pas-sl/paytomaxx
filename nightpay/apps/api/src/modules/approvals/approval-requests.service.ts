import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APPROVAL_REQUESTED_MESSAGE,
  alertSettingsOf,
  type ApprovalListQuery,
  type ApprovalListResponse,
  type ApprovalRequestedResponse,
  type ApprovalRules,
  type ApprovalStatus,
  type ApprovalView,
  type CreatePayoutDto,
  type PayoutMethod,
  type Role,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { isPayoutKeyClash, payoutKeyReused, type PayoutIdempotency } from '../operators/payout-idempotency';
import { payoutTotalCents } from '../operators/payout-math';
import { lockOperatorPayouts, payableSelection, payoutTotalChanged } from '../operators/payout-selection';
import { venueHoldDays } from '../operators/venue-hold-days';
import {
  REFUNDABLE_STATUSES,
  apiRefundedOnPaymentCents,
  assertRefundFits,
  lockPaymentForRefund,
} from '../refunds/refund-ledger';
import { isUniqueViolation, otherPayoutWithTx, txAlreadyUsed } from '../treasury/payout-tx-guard';
import { isAutoVerifiable } from '../treasury/verifiers/payout-verifier.interface';
import { ApprovalNotifier } from './approval-notifier';
import {
  buildPayoutPayload,
  toApprovalView,
  type ApprovalRow,
  type PersonRow,
  type RefundPayload,
} from './approval-payload';
import {
  DECISION_MESSAGES,
  decisionProblem,
  notPendingMessage,
  payoutRoute,
  personName,
  refundRoute,
  requestAlertText,
  rulesFor,
  type PayoutRoute,
  type RefundRoute,
  type VenueApprovalRules,
} from './approval-rules';
import {
  expirePending,
  expiryCutoff,
  payoutAlreadyRequested,
  pendingPayoutRequest,
  replayPayoutRequest,
  type ExpiredRow,
} from './approval-store';

/** Quien hace la petición (lo que sale del JWT). */
export interface ApprovalActor {
  userId: string;
  role: Role;
  tenantId: string;
}

export interface RefundToRequest {
  paymentId: string;
  amountCents: number;
  reason?: string;
}

/**
 * «Por aprobar»: crear las solicitudes (validando y reservando), listarlas,
 * rechazarlas y caducarlas. Aprobar (que hace lo pedido) está en
 * ApprovalsService, que usa los servicios de pagos y devoluciones.
 *
 * approval_requests tiene FORCE RLS: todo va en withTenant (el local de quien
 * pide) o, el repaso de caducadas, en acrossVenues.
 */
@Injectable()
export class ApprovalRequestsService {
  private readonly logger = new Logger(ApprovalRequestsService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly config: ConfigService;
  private readonly notifier: ApprovalNotifier;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(ApprovalNotifier) notifier: ApprovalNotifier,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.config = config;
    this.notifier = notifier;
  }

  // ─── Reglas ─────────────────────────────────────────────────────────

  /** Las reglas del local (venues no va por local ni tiene FORCE RLS: se lee con el id). */
  async venueRules(tenantId: string): Promise<VenueApprovalRules & { name: string }> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: tenantId },
      select: { name: true, payoutRequiresApproval: true, refundApprovalThresholdCents: true },
    });
    if (!venue) throw new NotFoundException('Local no encontrado');
    return venue;
  }

  async rules(actor: ApprovalActor): Promise<ApprovalRules> {
    return rulesFor(actor.role, await this.venueRules(actor.tenantId));
  }

  async payoutRouteFor(actor: ApprovalActor): Promise<PayoutRoute> {
    return payoutRoute(actor.role, await this.venueRules(actor.tenantId));
  }

  /**
   * Contando lo ya devuelto por la pasarela en ese cobro (pendiente o hecho)
   * por cualquiera. Sin candado: es para contestar 202 de entrada; la reserva
   * lo vuelve a mirar con el cobro bloqueado (RefundsService.reserveApiRefund).
   */
  async refundRouteFor(actor: ApprovalActor, amountCents: number, paymentId: string): Promise<RefundRoute> {
    const venue = await this.venueRules(actor.tenantId);
    if (actor.role !== 'MANAGER') return refundRoute(actor.role, amountCents, venue);
    const already = await this.prisma.withTenant(actor.tenantId, (tx) =>
      apiRefundedOnPaymentCents(tx, actor.tenantId, paymentId),
    );
    return refundRoute(actor.role, amountCents, venue, already);
  }

  // ─── Pedir ──────────────────────────────────────────────────────────

  /**
   * El encargado pide pagar a una chica. Se fija lo que entra (las comisiones
   * que ya pasaron la espera y la deuda abierta, bloqueadas) y su total; al
   * aprobarlo se paga exactamente eso. Una sola petición pendiente por chica
   * (candado de la chica + índice único parcial) y, mientras está pendiente,
   * nadie le paga esas comisiones por otro lado (assertNoPendingPayout).
   *
   * Como el pago directo: `dto.expectedTotalCents` (la cifra que vio) tiene
   * que ser lo pagable (si no, 409 PAYOUT_CHANGED y no se pide nada) y se
   * guarda para comprobarla otra vez al aprobar; con `idempotency`, repetir
   * la misma petición devuelve la misma solicitud (y otra con la clave, 409).
   */
  async requestPayout(
    actor: ApprovalActor,
    operatorId: string,
    dto: CreatePayoutDto,
    idempotency?: PayoutIdempotency,
  ): Promise<ApprovalRequestedResponse> {
    const holdDays = await venueHoldDays(this.prisma, this.config.get('PAYOUT_HOLD_DAYS'), actor.tenantId);
    const now = new Date();
    const result = await this.prisma
      .withTenant(actor.tenantId, async (tx) => {
        await lockOperatorPayouts(tx, operatorId);
        if (idempotency) {
          const prior = await replayPayoutRequest(tx, {
            tenantId: actor.tenantId,
            operatorId,
            requestedById: actor.userId,
            idempotency,
          });
          if (prior) return { replayed: true as const, row: prior };
        }
        const stale = await expirePending(tx, now, { targetId: operatorId });
        const already = await pendingPayoutRequest(tx, actor.tenantId, operatorId, now);
        if (already) throw payoutAlreadyRequested(already.amountCents);
        const payload = await this.payoutPayloadFor(tx, actor, operatorId, dto, holdDays, now);
        const created = await tx.approvalRequest.create({
          data: {
            tenantId: actor.tenantId,
            kind: 'PAYOUT',
            targetId: operatorId,
            amountCents: payload.totalCents,
            payload: payload.payload,
            requestedById: actor.userId,
            requestedAt: now,
            ...(idempotency ? { idempotencyKey: idempotency.key, idempotencyHash: idempotency.hash } : {}),
          },
        });
        return { replayed: false as const, row: created as ApprovalRow, expired: stale, operatorName: payload.payload.operatorName };
      })
      .catch((err: unknown) => {
        // A la vez, la misma clave en una petición para otra chica.
        if (isPayoutKeyClash(err)) throw payoutKeyReused();
        // A la vez, otro encargado pidió lo mismo (índice único parcial).
        if (isUniqueViolation(err)) throw payoutAlreadyRequested();
        throw err;
      });
    if (result.replayed) {
      this.logger.log(`Solicitud ${result.row.id} repetida con la misma Idempotency-Key: no se pide otra vez`);
      return this.requestedResponse(result.row);
    }
    const { row, expired, operatorName } = result;
    await this.auditExpired(expired);
    await this.requested(actor, row, { operatorId, operatorName });
    return this.requestedResponse(row);
  }

  private async payoutPayloadFor(
    tx: TransactionalClient,
    actor: ApprovalActor,
    operatorId: string,
    dto: CreatePayoutDto,
    holdDays: number,
    now: Date,
  ) {
    const operator = await tx.user.findFirst({
      where: { id: operatorId, tenantId: actor.tenantId, role: 'OPERATOR', deletedAt: null },
      select: { id: true, displayName: true, email: true, payoutMethod: true, payoutAddress: true, payoutLabel: true },
    });
    if (!operator) throw new NotFoundException('Operadora no encontrada');
    const method = dto.externalRail ?? operator.payoutMethod ?? null;
    if (!method) throw new BadRequestException('Elige cómo se le paga: la chica no tiene método de cobro guardado.');
    // Un hash on-chain solo vale para un pago del local (se vuelve a mirar al aprobarlo).
    const txId = dto.externalTxId?.trim();
    if (txId && isAutoVerifiable(method as PayoutMethod)) {
      const other = await otherPayoutWithTx(tx, actor.tenantId, null, txId);
      if (other) throw txAlreadyUsed(other);
    }
    const { pending, debts } = await payableSelection(tx, actor.tenantId, operatorId, holdDays, now);
    const totalCents = payoutTotalCents(pending, debts);
    if (totalCents <= 0) {
      throw new ConflictException(
        `Saldo neto ${totalCents / 100} € — no hay nada que liquidar (la operadora arrastra deuda por devoluciones).`,
      );
    }
    // Lo que vio el encargado ya no es lo pagable: no se pide otra cifra al dueño.
    if (dto.expectedTotalCents !== undefined && totalCents !== dto.expectedTotalCents) {
      throw payoutTotalChanged(totalCents, dto.expectedTotalCents);
    }
    const payload = buildPayoutPayload({
      operator,
      method,
      externalTxId: dto.externalTxId,
      receiptUrl: dto.receiptUrl,
      notes: dto.notes,
      earningIds: pending.map((e) => e.id),
      debtIds: debts.map((d) => d.id),
      holdDays,
      expectedTotalCents: dto.expectedTotalCents,
    });
    return { payload, totalCents };
  }

  /**
   * El encargado pide una devolución desde el umbral. Con la fila del cobro
   * bloqueada: se puede devolver, cabe (lo devolvible menos lo que reservan
   * las devoluciones en curso y las otras solicitudes) y queda reservada.
   */
  async requestRefund(actor: ApprovalActor, input: RefundToRequest): Promise<ApprovalRequestedResponse> {
    const now = new Date();
    const { row, expired } = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, tenantId: actor.tenantId },
        select: {
          id: true,
          amountCents: true,
          tipCents: true,
          provider: true,
          providerTxId: true,
          walletId: true,
          cardLast4: true,
          cardBrand: true,
          createdAt: true,
        },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      assertRefundableByApi(payment);
      const locked = await lockPaymentForRefund(tx, payment.id);
      if (!locked || !REFUNDABLE_STATUSES.has(locked.status)) {
        throw new ConflictException(`Cannot refund payment in state ${locked?.status ?? 'desconocido'}`);
      }
      const stale = await expirePending(tx, now, { targetId: payment.id });
      await assertRefundFits(tx, payment.id, locked, input.amountCents);
      const payload: RefundPayload = {
        paymentId: payment.id,
        reason: input.reason?.trim() || null,
        paymentAmountCents: payment.amountCents + payment.tipCents,
        paymentCreatedAt: payment.createdAt.toISOString(),
        cardLast4: payment.cardLast4,
        cardBrand: payment.cardBrand,
        provider: payment.provider,
      };
      const created = await tx.approvalRequest.create({
        data: {
          tenantId: actor.tenantId,
          kind: 'REFUND',
          targetId: payment.id,
          amountCents: input.amountCents,
          payload,
          requestedById: actor.userId,
          requestedAt: now,
        },
      });
      return { row: created, expired: stale };
    });
    await this.auditExpired(expired);
    const paymentAmountCents = (row.payload as { paymentAmountCents?: number }).paymentAmountCents ?? null;
    await this.requested(actor, row as ApprovalRow, { paymentId: input.paymentId, paymentAmountCents });
    return this.requestedResponse(row as ApprovalRow);
  }

  private requestedResponse(row: ApprovalRow): ApprovalRequestedResponse {
    return {
      approvalRequestId: row.id,
      status: 'PENDING',
      kind: row.kind,
      amountCents: row.amountCents,
      message: APPROVAL_REQUESTED_MESSAGE,
    };
  }

  /** Registro y aviso al dueño (Telegram, una vez; sin esperar a que salga). */
  private async requested(
    actor: ApprovalActor,
    row: ApprovalRow,
    detail: { operatorId?: string; operatorName?: string; paymentId?: string; paymentAmountCents?: number | null },
  ): Promise<void> {
    await this.audit.log({
      action: 'approval.requested',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ApprovalRequest',
      targetId: row.id,
      payload: { kind: row.kind, amountCents: row.amountCents, targetId: row.targetId },
    });
    this.logger.log(`Solicitud ${row.id} (${row.kind}, ${row.amountCents}c) pedida por ${actor.userId}`);
    if (!this.notifier.enabled()) return;
    void this.alertOwner(actor, row, detail).catch((err: unknown) =>
      this.logger.warn(`Aviso de la solicitud ${row.id} sin mandar: ${(err as Error).message}`),
    );
  }

  private async alertOwner(
    actor: ApprovalActor,
    row: ApprovalRow,
    detail: { operatorName?: string; paymentAmountCents?: number | null },
  ): Promise<void> {
    const [venue, requester, alerts] = await Promise.all([
      this.venueRules(actor.tenantId),
      this.prisma.acrossVenues((tx) =>
        tx.user.findUnique({ where: { id: actor.userId }, select: { displayName: true, email: true } }),
      ),
      this.prisma.asSystem((tx) =>
        tx.venue.findUnique({ where: { id: actor.tenantId }, select: { alertSettings: true } }),
      ),
    ]);
    // Ajustes → Avisos: «Por aprobar» apagado no se avisa; sin nombres, sin el de la chica.
    const settings = alertSettingsOf(alerts?.alertSettings);
    if (!settings.kinds.approvals) return;
    const text = requestAlertText({
      venueName: venue.name,
      kind: row.kind,
      requester: personName(requester),
      requesterRole: actor.role,
      amountCents: row.amountCents,
      operatorName: settings.includeNames ? (detail.operatorName ?? null) : null,
      paymentAmountCents: detail.paymentAmountCents ?? null,
    });
    await this.notifier.requested(actor.tenantId, row.id, text, settings.chatId);
  }

  // ─── Leer ───────────────────────────────────────────────────────────

  /**
   * El dueño ve todas las del local; el encargado, las suyas. Antes de leer
   * se caducan las de más de 24 h (también lo hace el repaso periódico).
   */
  async list(actor: ApprovalActor, query: ApprovalListQuery): Promise<ApprovalListResponse> {
    const now = new Date();
    const { rows, expired } = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const stale = await expirePending(tx, now);
      const found = await tx.approvalRequest.findMany({
        where: {
          tenantId: actor.tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(actor.role === 'OWNER' ? {} : { requestedById: actor.userId }),
        },
        // Pendientes: la más antigua (la que antes caduca) primero.
        orderBy: { requestedAt: query.status === 'PENDING' ? 'asc' : 'desc' },
        take: query.limit,
      });
      return { rows: found as ApprovalRow[], expired: stale };
    });
    await this.auditExpired(expired);
    return { items: await this.views(actor, rows, now) };
  }

  async findRow(tenantId: string, id: string): Promise<ApprovalRow | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.approvalRequest.findFirst({ where: { id, tenantId } }),
    );
    return row as ApprovalRow | null;
  }

  async view(actor: ApprovalActor, row: ApprovalRow): Promise<ApprovalView> {
    const [one] = await this.views(actor, [row], new Date());
    return one!;
  }

  private async views(actor: ApprovalActor, rows: readonly ApprovalRow[], now: Date): Promise<ApprovalView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.requestedById, ...(r.decidedById ? [r.decidedById] : [])]))];
    // Personas por id en cualquier local: quien aprueba puede ser un super-admin de otro.
    const people: PersonRow[] =
      ids.length === 0
        ? []
        : await this.prisma.acrossVenues((tx) =>
            tx.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, displayName: true, email: true, role: true },
            }),
          );
    const byId = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => toApprovalView(r, byId, decisionProblem(actor, r, now) === null));
  }

  // ─── Rechazar ───────────────────────────────────────────────────────

  /** El dueño la rechaza con el motivo (lo ve el encargado). Rechazar dos veces no cambia nada. */
  async reject(actor: ApprovalActor, id: string, note: string): Promise<ApprovalView> {
    const now = new Date();
    const row = await this.decidable(actor, id, now, 'REJECTED');
    if (row.status === 'REJECTED') return this.view(actor, row);
    const { count } = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.approvalRequest.updateMany({
        where: { id, tenantId: actor.tenantId, status: 'PENDING', requestedAt: { gt: expiryCutoff(now) } },
        data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: now, decisionNote: note },
      }),
    );
    const after = await this.findRow(actor.tenantId, id);
    if (!after) throw new NotFoundException('Solicitud no encontrada');
    if (count !== 1) {
      if (after.status === 'REJECTED') return this.view(actor, after);
      throw new ConflictException({ message: notPendingMessage(after.status), code: 'APPROVAL_NOT_PENDING' });
    }
    await this.audit.log({
      action: 'approval.rejected',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ApprovalRequest',
      targetId: id,
      payload: { kind: after.kind, amountCents: after.amountCents, note },
    });
    return this.view(actor, after);
  }

  /**
   * La solicitud, si esta persona puede decidir sobre ella. Ya decidida como
   * `idempotentAs` (aprobar/rechazar dos veces) → se devuelve tal cual; ya
   * decidida de otra forma → 409; caducada → se marca y 409; quien la pidió
   * o quien no es dueño → 403.
   */
  async decidable(
    actor: ApprovalActor,
    id: string,
    now: Date,
    idempotentAs: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>,
  ): Promise<ApprovalRow> {
    const row = await this.findRow(actor.tenantId, id);
    if (!row) throw new NotFoundException('Solicitud no encontrada');
    const problem = decisionProblem(actor, row, now);
    if (problem === null) return row;
    if (problem === 'not_pending') {
      if (row.status === idempotentAs) return row;
      throw new ConflictException({ message: notPendingMessage(row.status), code: 'APPROVAL_NOT_PENDING' });
    }
    if (problem === 'expired') {
      const expired = await this.prisma.withTenant(actor.tenantId, (tx) => expirePending(tx, now, { targetId: row.targetId }));
      await this.auditExpired(expired);
      throw new ConflictException({ message: DECISION_MESSAGES.expired, code: 'APPROVAL_EXPIRED' });
    }
    throw new ForbiddenException({
      message: DECISION_MESSAGES[problem],
      code: problem === 'own_request' ? 'APPROVAL_OWN_REQUEST' : 'APPROVAL_FORBIDDEN',
    });
  }

  /**
   * Lo aprobado no se pudo hacer por cómo están las cosas (ya pagado, no
   * cabe…): queda fallida con la razón. `from` = el estado en que se dejó
   * (PENDING si falló antes de marcarla; APPROVED si la pasarela la rechazó).
   */
  async markFailed(row: ApprovalRow, actor: ApprovalActor, reason: string, from: 'PENDING' | 'APPROVED'): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.withTenant(row.tenantId, (tx) =>
      tx.approvalRequest.updateMany({
        where: { id: row.id, tenantId: row.tenantId, status: from },
        data: {
          status: 'FAILED',
          failureReason: reason,
          ...(from === 'PENDING' ? { decidedById: actor.userId, decidedAt: now } : {}),
        },
      }),
    );
    // Otra persona la decidió entretanto: no se toca ni se apunta nada.
    if (count !== 1) return false;
    await this.audit.log({
      action: 'approval.failed',
      tenantId: row.tenantId,
      actorId: actor.userId,
      targetType: 'ApprovalRequest',
      targetId: row.id,
      payload: { kind: row.kind, amountCents: row.amountCents, reason, resultRef: row.resultRef },
    });
    return true;
  }

  // ─── Caducar ────────────────────────────────────────────────────────

  /** Repaso de todos los locales: las pendientes de más de 24 h pasan a caducadas. */
  async expireStale(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.acrossVenues((tx) => expirePending(tx, now));
    await this.auditExpired(expired);
    return expired.length;
  }

  private async auditExpired(rows: readonly ExpiredRow[]): Promise<void> {
    for (const r of rows) {
      await this.audit.log({
        action: 'approval.expired',
        tenantId: r.tenantId,
        actorId: null,
        targetType: 'ApprovalRequest',
        targetId: r.id,
        payload: { kind: r.kind, amountCents: r.amountCents, requestedById: r.requestedById },
      });
    }
  }
}

/** Solo se piden las devoluciones que se hacen por la pasarela (como POST /payments/:id/refunds). */
function assertRefundableByApi(payment: { provider: string | null; providerTxId: string | null; walletId: string | null }): void {
  if (payment.walletId) {
    throw new ConflictException('Es una recarga de saldo: se devuelve desde Wallets → Devolver saldo');
  }
  if (!payment.providerTxId || !payment.provider) {
    throw new ConflictException('Payment has no provider transaction id');
  }
  if (payment.provider === 'REDSYS') {
    throw new ConflictException(
      'Redsys no devuelve por API: el dueño la hace en el portal de BBVA y la apunta en «Devolución BBVA».',
    );
  }
}
