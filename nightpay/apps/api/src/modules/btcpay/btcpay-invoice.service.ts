import { randomUUID } from 'node:crypto';
import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import * as QRCode from 'qrcode';
import type { BtcpayInvoiceStatus, BtcpayInvoiceView } from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import type { RequestContext } from '../../common/context/request-context';
import { inVenue } from '../../common/context/in-venue';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GatewayTransientError } from '../gateways/gateway-errors';
import { InvalidTransitionError, isIdempotentTransition } from '../payments/payment.machine';
import { PaymentsService } from '../payments/payments.service';
import { assertVenueNotPaused, VENUE_PAUSE_SELECT } from '../venues/venue-pause';
import { judgeInvoice, purposeAllows, unifiedPaymentLink, type InvoiceData, type InvoiceVerdict } from './btcpay-logic';
import { BtcpayStoreService, messageOfBtcpayError, type BtcpayAccess } from './btcpay-store.service';

/** Lo que dura una factura de bitcoin: 15 minutos (el cambio queda fijo ese rato). */
export const INVOICE_MINUTES = 15;
/** Como mucho una pregunta a BTCPay por factura cada tanto, aunque la pantalla pregunte más. */
export const INVOICE_POLL_MIN_MS = 5_000;
/** Cuántas facturas abiertas repasa cada vuelta de la tarea de respaldo. */
const SWEEP_BATCH = 200;
/** Pasadas tantas horas de su caducidad, el repaso deja de mirar una factura abierta (la verá una persona). */
const SWEEP_GIVE_UP_AFTER_MS = 6 * 3_600_000;

const OPENABLE_STATES: ReadonlySet<string> = new Set(['CREATED', 'AWAITING_CAPTURE']);
const PAID_STATES: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export const APPROVAL_UNVERIFIED_EVENT = 'payment.approval_unverified';
export const APPROVAL_UNBOOKED_EVENT = 'payment.approval_unbooked';

/** Cómo va la factura de un cobro para la pantalla del cliente (JSON de /pay/:token/bitcoin/status). */
export type BitcoinPollState =
  | { state: 'open'; status: BtcpayInvoiceStatus; expiresAt: string }
  | { state: 'paid' }
  /** La factura se cerró sin pagarse y el cobro sigue abierto: puede pagar de otra forma. */
  | { state: 'closed'; reopened: boolean }
  /** Pago a medias o tardío: lo ve el personal, la pantalla no da nada por pagado. */
  | { state: 'incident' }
  | { state: 'gone' };

export type BitcoinStartResult =
  | { kind: 'invoice'; view: BtcpayInvoiceView }
  | { kind: 'paid' }
  | { kind: 'closed'; reason: 'expired' | 'canceled' | 'failed' };

/**
 * «Pagar de otra forma» en la página del QR:
 *  - 'choose': la factura se cerró (o ya no había) y el cobro vuelve a la página de pago;
 *  - 'paid': el bitcoin ya llegó (se ve el «Pagado»);
 *  - 'confirming': el pago ya está en la red esperando su confirmación: no se cierra.
 */
export type BitcoinLeaveResult = { kind: 'choose' } | { kind: 'paid' } | { kind: 'confirming' };

type InvoiceRow = {
  id: string;
  tenantId: string;
  paymentId: string;
  invoiceId: string;
  storeId: string;
  status: string;
  additionalStatus: string | null;
  amountCents: number;
  amountBtc: string | null;
  rate: string | null;
  checkoutLink: string;
  qrLink: string;
  chainAddress: string | null;
  expiresAt: Date;
  closedAt: Date | null;
  lastCheckedAt: Date | null;
};

interface PaymentCtx {
  id: string;
  tenantId: string;
  status: string;
  provider: string | null;
  providerTxId: string | null;
  amountCents: number;
  serviceFeeCents: number;
  currency: string;
  qrExpiresAt: Date;
  walletId: string | null;
  createdByUserId: string | null;
}

export interface StaffActor {
  userId: string;
  role: string;
  tenantId: string;
}

@Injectable()
export class BtcpayInvoiceService implements OnModuleInit {
  private readonly logger = new Logger(BtcpayInvoiceService.name);
  /** Dos «Pagar con bitcoin» a la vez del mismo cobro en este proceso: una sola factura. */
  private readonly opening = new Map<string, Promise<InvoiceRow>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ClsService) private readonly cls: ClsService<{ ctx: RequestContext }>,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(BtcpayStoreService) private readonly stores: BtcpayStoreService,
  ) {}

  onModuleInit(): void {
    this.payments.registerCancelHook((paymentId, tenantId) => this.closeOnCancel(paymentId, tenantId));
  }

  // ─── Abrir o reutilizar la factura ───────────────────────────────────

  /** El cliente toca «Pagar con bitcoin» en /pay/:token. */
  async startForToken(qrToken: string, claimHash: string | null): Promise<BitcoinStartResult> {
    const payment = await this.paymentByToken(qrToken);
    return this.start(payment, claimHash);
  }

  /** El personal pide el QR de bitcoin de un cobro (quien lo hizo o el encargado). */
  async startForStaff(paymentId: string, actor: StaffActor): Promise<BtcpayInvoiceView> {
    const payment = await this.paymentForStaff(paymentId, actor);
    const result = await this.start(payment, null);
    if (result.kind === 'invoice') return result.view;
    throw new ConflictException(
      result.kind === 'paid' ? 'Este cobro ya está pagado.' : 'Este cobro ya no se puede pagar (caducado, cancelado o fallido).',
    );
  }

  /** Su factura abierta, para pintar el QR (null si no hay). Solo lectura, sin preguntar a BTCPay. */
  async viewForStaff(paymentId: string, actor: StaffActor): Promise<BtcpayInvoiceView | null> {
    const payment = await this.paymentForStaff(paymentId, actor);
    const row = await this.latestInvoiceOf(payment.id);
    return row ? this.toView(row, payment.status) : null;
  }

  /** La factura abierta del cobro, para la página del cliente (sin crear nada). */
  async viewForToken(qrToken: string): Promise<{ payment: PaymentCtx; view: BtcpayInvoiceView | null }> {
    const payment = await this.paymentByToken(qrToken);
    const row = await this.openInvoiceOf(payment.id);
    return { payment, view: row ? await this.toView(row, payment.status) : null };
  }

  private async start(payment: PaymentCtx, claimHash: string | null): Promise<BitcoinStartResult> {
    if (PAID_STATES.has(payment.status)) return { kind: 'paid' };
    const access = await this.stores.accessFor(payment.tenantId);
    if (!access || !access.enabled || !purposeAllows(access.purpose, payment.walletId !== null)) {
      throw new ConflictException({ code: 'BTCPAY_NOT_OFFERED', message: 'Este local no cobra con bitcoin.' });
    }
    const existing = await this.openInvoiceOf(payment.id);
    // (Una factura Processing ya tiene el pago en la red: espera su confirmación aunque pase de los 15 min.)
    if (existing && (existing.expiresAt.getTime() > Date.now() || existing.status === 'Processing')) {
      return { kind: 'invoice', view: await this.toView(existing, payment.status) };
    }
    if (existing) {
      // Caducada y aún sin cerrar: se mira qué pasó antes de abrir otra (puede haberse pagado a última hora).
      await this.processInvoice(existing.tenantId, existing.invoiceId, 'poll').catch(() => undefined);
    }
    const fresh = await this.paymentByToken(payment.id, 'id');
    if (PAID_STATES.has(fresh.status)) return { kind: 'paid' };
    if (fresh.status === 'CANCELED') return { kind: 'closed', reason: 'canceled' };
    if (fresh.status === 'EXPIRED') return { kind: 'closed', reason: 'expired' };
    if (fresh.status === 'FAILED') return { kind: 'closed', reason: 'failed' };
    const row = await this.coalesced(fresh, access, claimHash);
    return { kind: 'invoice', view: await this.toView(row, (await this.paymentByToken(fresh.id, 'id')).status) };
  }

  /**
   * El cliente toca «Pagar de otra forma» en la página del QR: la factura se
   * cierra aquí (la página deja de enseñarla) y el cobro vuelve a estar abierto
   * para pagarlo con tarjeta o con el saldo. Antes se pregunta a BTCPay: un pago
   * que acaba de llegar, o que ya está en la red, no se pierde al cerrarla.
   */
  async leaveForToken(qrToken: string): Promise<BitcoinLeaveResult> {
    const payment = await this.paymentByToken(qrToken);
    if (PAID_STATES.has(payment.status)) return { kind: 'paid' };
    const open = await this.openInvoiceOf(payment.id);
    if (!open) return { kind: 'choose' };
    await this.processInvoice(open.tenantId, open.invoiceId, 'poll').catch((err: unknown) =>
      this.logger.warn(`«Pagar de otra forma» con la factura ${open.invoiceId}: BTCPay no contestó (${(err as Error).message})`),
    );
    if (await this.closeForOtherWay(payment.id)) return { kind: 'choose' };
    // Otro camino se adelantó (ya pagado, el pago en la red o la factura ya cerrada): lo dice el estado de ahora.
    const now = await this.paymentByToken(payment.id, 'id');
    if (PAID_STATES.has(now.status)) return { kind: 'paid' };
    return (await this.openInvoiceOf(payment.id))?.status === 'Processing' ? { kind: 'confirming' } : { kind: 'choose' };
  }

  /**
   * Cierra la factura abierta (solo si sigue «New»: sin pago en la red) y reabre
   * el cobro, todo con el cobro bloqueado. Después la invalida en BTCPay si la
   * clave deja; si no, el repaso la sigue mirando hasta que caduque allí: un pago
   * que llegue a pesar de todo queda en Incidencias, nunca se pierde.
   */
  private async closeForOtherWay(paymentId: string): Promise<boolean> {
    const row = await this.openInvoiceOf(paymentId);
    if (!row || row.status !== 'New') return false;
    try {
      await this.payments.transition(paymentId, { type: 'INVOICE_CLOSED' }, row.tenantId, {
        prepare: async (tx, locked) => {
          if (locked.status !== 'AUTHORIZING' || locked.provider !== 'BTCPAY' || locked.providerTxId !== row.invoiceId) {
            throw new InvalidTransitionError(locked.status, 'INVOICE_CLOSED');
          }
          const closed = await tx.$executeRaw`
            UPDATE btcpay_invoices SET status = 'Invalid', "lastCheckedAt" = now(), "updatedAt" = now()
             WHERE id = ${row.id}::uuid AND status = 'New'`;
          if (closed !== 1) throw new InvalidTransitionError(locked.status, 'INVOICE_CLOSED');
        },
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) return false;
      throw err;
    }
    this.logger.log(`Cobro ${paymentId}: el cliente eligió pagar de otra forma; factura ${row.invoiceId} cerrada`);
    await this.expireIfPastDeadline(paymentId, row.tenantId);
    await this.invalidateInBtcpay(row);
    return true;
  }

  /** El cobro reabierto ya había pasado su plazo: caduca (como al caducar la factura). */
  private async expireIfPastDeadline(paymentId: string, tenantId: string): Promise<void> {
    const payment = await this.paymentByToken(paymentId, 'id').catch(() => null);
    if (!payment || payment.qrExpiresAt.getTime() > Date.now()) return;
    await this.payments.transition(paymentId, { type: 'TIMEOUT' }, tenantId).catch((err: unknown) => {
      if (!(err instanceof InvalidTransitionError)) throw err;
    });
  }

  private coalesced(payment: PaymentCtx, access: BtcpayAccess, claimHash: string | null): Promise<InvoiceRow> {
    const running = this.opening.get(payment.id);
    if (running) return running;
    const job = this.openInvoice(payment, access, claimHash).finally(() => this.opening.delete(payment.id));
    this.opening.set(payment.id, job);
    return job;
  }

  private async openInvoice(payment: PaymentCtx, access: BtcpayAccess, claimHash: string | null): Promise<InvoiceRow> {
    const open = await this.openInvoiceOf(payment.id);
    if (open && (open.expiresAt.getTime() > Date.now() || open.status === 'Processing')) return open;
    if (!OPENABLE_STATES.has(payment.status)) throw new ConflictException({ code: 'PAYMENT_ALREADY_STARTED', message: 'Este cobro ya se está pagando de otra forma.' });
    if (payment.qrExpiresAt.getTime() < Date.now()) throw new ConflictException('QR expired');
    await this.assertVenueCharges(payment.tenantId);

    // El importe sale SIEMPRE del servidor: lo mismo que pagaría con tarjeta (importe + comisión del servicio).
    const chargeCents = payment.amountCents + payment.serviceFeeCents;
    const client = this.stores.clientFor(access);
    let invoice: InvoiceData;
    let link: ReturnType<typeof unifiedPaymentLink>;
    try {
      invoice = await client.createInvoice({ amountCents: chargeCents, orderId: payment.id, expirationMinutes: INVOICE_MINUTES });
      const methods = await client.getPaymentMethods(invoice.id);
      link = unifiedPaymentLink(methods);
    } catch (err) {
      this.logger.error(`Factura de bitcoin del cobro ${payment.id}: ${(err as Error).message}`);
      if (err instanceof GatewayTransientError) {
        throw new HttpException({ code: 'GATEWAY_RETRY', message: 'No se pudo abrir el pago con bitcoin. Inténtalo de nuevo.' }, HttpStatus.CONFLICT);
      }
      throw new ConflictException({ code: 'BTCPAY_FAILED', message: messageOfBtcpayError(err) });
    }
    // Lo recién creado tiene que ser exactamente lo pedido (tienda, cobro, euros e importe).
    const verdict = judgeInvoice(invoice, { storeId: access.storeId, orderId: payment.id, amountCents: chargeCents });
    if (verdict.kind !== 'OPEN' || !link) {
      await client.markInvalid(invoice.id).catch(() => false);
      this.logger.error(`Factura ${invoice.id} del cobro ${payment.id} no vale (${verdict.kind}${link ? '' : ', sin métodos de pago'})`);
      throw new ConflictException({ code: 'BTCPAY_FAILED', message: 'BTCPay no pudo preparar el pago con bitcoin. Avisa al local.' });
    }
    const expiresAt = new Date(invoice.expirationTime * 1000);
    try {
      await inVenue(this.cls, payment.tenantId, () =>
        this.payments.transition(payment.id, { type: 'AUTHORIZING' }, payment.tenantId, {
          prepare: async (tx, locked) => {
            if (!OPENABLE_STATES.has(locked.status)) throw new InvalidTransitionError(locked.status, 'AUTHORIZING');
            try {
              await tx.btcpayInvoice.create({
                data: {
                  tenantId: payment.tenantId,
                  paymentId: payment.id,
                  invoiceId: invoice.id,
                  storeId: access.storeId,
                  status: invoice.status,
                  amountCents: chargeCents,
                  amountBtc: link?.amountBtc ?? null,
                  rate: link?.rate ?? null,
                  checkoutLink: invoice.checkoutLink,
                  qrLink: link?.link ?? '',
                  chainAddress: link?.chainAddress ?? null,
                  expiresAt,
                },
              });
            } catch (err) {
              // Otra petición abrió la suya primero (índice único de una abierta por cobro).
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new InvalidTransitionError(locked.status, 'AUTHORIZING');
              throw err;
            }
            await tx.paymentAttempt.create({
              data: {
                id: randomUUID(),
                paymentId: payment.id,
                tenantId: payment.tenantId,
                provider: 'BTCPAY',
                providerTxId: invoice.id,
                amountCents: chargeCents,
                tipCents: 0,
                payMethod: 'bitcoin',
                claimHash,
              },
            });
            await tx.payment.update({ where: { id: payment.id }, data: { provider: 'BTCPAY', providerTxId: invoice.id } });
            // El cobro no caduca antes que su factura: el plazo del cobro se alinea con el de la factura.
            await tx.$executeRaw`UPDATE payments SET "qrExpiresAt" = GREATEST("qrExpiresAt", ${expiresAt}) WHERE id = ${payment.id}::uuid`;
            return { provider: 'BTCPAY', providerTxId: invoice.id };
          },
        }),
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // Otra petición ganó: la factura de esta se descarta y se devuelve la que quedó.
        await client.markInvalid(invoice.id).catch(() => false);
        const winner = await this.openInvoiceOf(payment.id);
        if (winner) return winner;
        throw new ConflictException({ code: 'PAYMENT_ALREADY_STARTED', message: 'Este cobro ya se está pagando de otra forma.' });
      }
      throw err;
    }
    this.logger.log(`Cobro ${payment.id}: factura de bitcoin ${invoice.id} (${chargeCents} c)`);
    return this.rowOrThrow(invoice.id);
  }

  // ─── Mirar la factura: aviso, pantalla, tarea de respaldo ────────────

  /**
   * Vuelve a pedir la factura a BTCPay y aplica el resultado con las mismas
   * comprobaciones estrictas, venga del aviso, de la pantalla o de la tarea:
   * solo `Settled` con tienda, cobro, euros e importe exactos da el cobro por
   * pagado, una sola vez.
   */
  async processInvoice(tenantId: string, invoiceId: string, source: 'webhook' | 'poll' | 'sweep'): Promise<InvoiceVerdict | { kind: 'UNKNOWN' }> {
    const row = await this.prisma.asSystem((tx) => tx.btcpayInvoice.findUnique({ where: { invoiceId } }));
    // Una factura que no es de este local (o que no abrimos nosotros) no se toca.
    if (!row || row.tenantId !== tenantId) return { kind: 'UNKNOWN' };
    const access = await this.stores.accessFor(tenantId);
    if (!access) throw new Error(`El local ${tenantId} ya no tiene BTCPay: no se puede comprobar la factura ${invoiceId}`);
    const invoice = await this.stores.clientFor(access).getInvoice(invoiceId);
    const verdict = judgeInvoice(invoice, { storeId: access.storeId, orderId: row.paymentId, amountCents: row.amountCents });
    this.logger.log(`Factura ${invoiceId} (${source}): ${invoice.status}${invoice.additionalStatus && invoice.additionalStatus !== 'None' ? `/${invoice.additionalStatus}` : ''} → ${verdict.kind}`);
    await this.apply(row, invoice, verdict);
    return verdict;
  }

  /**
   * Un aviso ya verificado y guardado (webhook_deliveries): se saca la factura
   * del cuerpo y se vuelve a pedir a BTCPay. Un fallo pasajero se lanza para que
   * BullMQ reintente; la tarea de respaldo lo cubre si se agotan los reintentos.
   */
  async handleDelivery(tenantId: string | null, rawBody: Buffer): Promise<void> {
    if (!tenantId) return;
    let invoiceId: unknown;
    try {
      invoiceId = (JSON.parse(rawBody.toString('utf8')) as { invoiceId?: unknown }).invoiceId;
    } catch {
      return;
    }
    if (typeof invoiceId !== 'string' || invoiceId.length === 0) return;
    await this.processInvoice(tenantId, invoiceId, 'webhook');
  }

  private async apply(row: InvoiceRow, invoice: InvoiceData, verdict: InvoiceVerdict): Promise<void> {
    const additional = invoice.additionalStatus ?? null;
    switch (verdict.kind) {
      // Primero el efecto y después cerrar la fila: si el efecto falla (base, Redis), la factura sigue
      // abierta y el repaso la vuelve a mirar. Los efectos son idempotentes (AUTHORIZED→AUTHORIZED, una incidencia por factura y motivo).
      case 'PAID':
        await this.settle(row);
        await this.touch(row.id, { status: 'Settled', additionalStatus: additional, closedAt: new Date() });
        return;
      case 'OPEN':
        // Cerrada aquí (cobro cancelado o «Pagar de otra forma») y aún abierta en BTCPay: sigue cerrada; el repaso la vigila.
        await this.touch(row.id, row.status === 'Invalid' ? { additionalStatus: additional } : { status: invoice.status, additionalStatus: additional });
        return;
      case 'CLOSED':
        await this.reopen(row);
        await this.touch(row.id, { status: verdict.status, additionalStatus: additional, closedAt: new Date() });
        return;
      case 'INCIDENT':
        // Pago a medias o tardío: la factura se cierra, el cobro NO se da por pagado ni se reabre (lo resuelve una persona).
        await this.recordIncident(row, APPROVAL_UNVERIFIED_EVENT, { reason: `btcpay-${verdict.reason.toLowerCase()}`, source: 'btcpay', paidStatus: additional });
        await this.touch(row.id, { status: invoice.status === 'Settled' ? 'Settled' : invoice.status === 'Invalid' ? 'Invalid' : 'Expired', additionalStatus: additional, closedAt: new Date() });
        return;
      case 'REJECTED':
        // La factura no es lo que pedimos: se cierra para no volver a mirarla y queda en Incidencias.
        await this.recordIncident(row, APPROVAL_UNVERIFIED_EVENT, { reason: `btcpay-${verdict.reason.toLowerCase()}`, source: 'btcpay' });
        await this.touch(row.id, { status: 'Invalid', additionalStatus: additional, closedAt: new Date() });
        return;
    }
  }

  /** El cobro pasa a pagado, una sola vez. Si ya no se puede (cancelado, caducado…), Incidencias. */
  private async settle(row: InvoiceRow): Promise<void> {
    try {
      await this.payments.transition(row.paymentId, { type: 'AUTHORIZED', provider: 'BTCPAY', providerTxId: row.invoiceId }, row.tenantId);
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      if (isIdempotentTransition(err)) {
        await this.flagIfPaidOtherWay(row, err.fromState);
        return;
      }
      // El bitcoin ya llegó y el cobro no se puede dar por pagado: nunca «Pagado», siempre incidencia.
      await this.recordIncident(row, APPROVAL_UNBOOKED_EVENT, { fromStatus: err.fromState });
    }
  }

  /**
   * El cobro ya estaba pagado. Con esta factura (un aviso repetido) o con otra de
   * bitcoin (transition() apunta el doble cobro), nada más. Pagado con tarjeta u
   * otra forma y ADEMÁS con esta factura (el cliente pagó de las dos maneras): ese
   * bitcoin sobra y nadie lo apuntaría, así que queda en Incidencias para devolverlo.
   */
  private async flagIfPaidOtherWay(row: InvoiceRow, fromStatus: string): Promise<void> {
    const payment = await this.paymentByToken(row.paymentId, 'id').catch(() => null);
    if (!payment || payment.provider === 'BTCPAY') return;
    await this.recordIncident(row, APPROVAL_UNBOOKED_EVENT, { fromStatus, paidWith: payment.provider });
  }

  /** La factura se cerró sin pagarse: si el cobro la esperaba, vuelve a estar abierto (o caduca si ya era su hora). */
  private async reopen(row: InvoiceRow): Promise<void> {
    const payment = await this.paymentByToken(row.paymentId, 'id').catch(() => null);
    if (!payment || payment.status !== 'AUTHORIZING' || payment.providerTxId !== row.invoiceId) return;
    try {
      await this.payments.transition(row.paymentId, { type: 'INVOICE_CLOSED' }, row.tenantId);
    } catch (err) {
      if (err instanceof InvalidTransitionError) return;
      throw err;
    }
    await this.expireIfPastDeadline(row.paymentId, row.tenantId);
  }

  /** Apunta la incidencia una sola vez por factura y motivo (el aviso, la pantalla y la tarea pueden coincidir). */
  private async recordIncident(row: InvoiceRow, eventType: string, extra: Record<string, unknown>): Promise<void> {
    const reason = typeof extra.reason === 'string' ? extra.reason : (typeof extra.fromStatus === 'string' ? extra.fromStatus : '');
    await this.prisma.asSystem(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`btcpay-incident:${row.invoiceId}`}))`;
      const already = await tx.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS one FROM payment_events
         WHERE "paymentId" = ${row.paymentId}::uuid AND "eventType" = ${eventType}
           AND payload->>'providerTxId' = ${row.invoiceId} AND COALESCE(payload->>'key', '') = ${reason}
         LIMIT 1`;
      if (already.length > 0) return;
      await tx.paymentEvent.create({
        data: {
          paymentId: row.paymentId,
          tenantId: row.tenantId,
          eventType,
          payload: { provider: 'BTCPAY', providerTxId: row.invoiceId, amountCents: row.amountCents, key: reason, ...extra },
          traceId: randomUUID(),
        },
      });
    });
    this.logger.error(`Factura ${row.invoiceId}: ${eventType} (${reason}) en el cobro ${row.paymentId} — queda en Incidencias`);
  }

  // ─── Lo que pregunta la pantalla ─────────────────────────────────────

  /** Estado para la cuenta atrás: pregunta a BTCPay como mucho una vez cada 5 s por factura. */
  async pollForToken(qrToken: string): Promise<BitcoinPollState> {
    let payment = await this.paymentByToken(qrToken).catch(() => null);
    if (!payment) return { state: 'gone' };
    if (PAID_STATES.has(payment.status)) return { state: 'paid' };
    let open = await this.openInvoiceOf(payment.id);
    if (open && (await this.claimPoll(open.id))) {
      await this.processInvoice(open.tenantId, open.invoiceId, 'poll').catch((err: unknown) =>
        this.logger.warn(`Respaldo por consulta de ${open?.invoiceId}: ${(err as Error).message}`),
      );
      payment = await this.paymentByToken(payment.id, 'id');
      open = await this.openInvoiceOf(payment.id);
    }
    if (PAID_STATES.has(payment.status)) return { state: 'paid' };
    if (open) return { state: 'open', status: open.status as BtcpayInvoiceStatus, expiresAt: open.expiresAt.toISOString() };
    const latest = await this.latestInvoiceOf(payment.id);
    if (latest?.additionalStatus === 'PaidPartial' || latest?.additionalStatus === 'PaidLate' || (latest?.status === 'Settled' && !PAID_STATES.has(payment.status))) {
      return { state: 'incident' };
    }
    if (payment.status === 'AUTHORIZING' && payment.provider === 'BTCPAY') return { state: 'incident' };
    return { state: 'closed', reopened: OPENABLE_STATES.has(payment.status) };
  }

  /** Atómico: solo una pregunta a BTCPay por factura cada INVOICE_POLL_MIN_MS, aunque lleguen varias a la vez. */
  private async claimPoll(rowId: string): Promise<boolean> {
    const claimed = await this.prisma.asSystem((tx) => tx.$queryRaw<Array<{ id: string }>>`
      UPDATE btcpay_invoices SET "lastCheckedAt" = now()
       WHERE id = ${rowId}::uuid
         AND ("lastCheckedAt" IS NULL OR "lastCheckedAt" < now() - make_interval(secs => ${INVOICE_POLL_MIN_MS / 1000}))
      RETURNING id`);
    return claimed.length > 0;
  }

  /** La tarea de respaldo: repasa las facturas abiertas (cada 2 minutos) por si el aviso no llegó. */
  async sweepOpen(now: Date = new Date()): Promise<{ checked: number; failed: number }> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.btcpayInvoice.findMany({
        // Las abiertas que BTCPay aún vigila: pasadas unas horas de su caducidad, una factura que no se deja
        // comprobar (el local ya no tiene BTCPay…) no tapa a las demás ni se reintenta para siempre.
        // Las Processing (pago ya en la red, esperando su confirmación) se vigilan siempre.
        // También las cerradas aquí que BTCPay no dejó invalidar (cobro cancelado, «Pagar de otra
        // forma»): siguen pagables allí hasta caducar y un pago que llegue tiene que quedar en Incidencias.
        where: {
          OR: [
            { status: 'Processing' },
            { status: 'New', expiresAt: { gt: new Date(now.getTime() - SWEEP_GIVE_UP_AFTER_MS) } },
            { status: 'Invalid', closedAt: null, expiresAt: { gt: new Date(now.getTime() - SWEEP_GIVE_UP_AFTER_MS) } },
          ],
        },
        orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: SWEEP_BATCH,
        select: { id: true, tenantId: true, invoiceId: true },
      }),
    );
    let checked = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        if (!(await this.claimPoll(r.id))) continue;
        await this.processInvoice(r.tenantId, r.invoiceId, 'sweep');
        checked += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(`Repaso de la factura ${r.invoiceId} (${now.toISOString()}): ${(err as Error).message}`);
      }
    }
    return { checked, failed };
  }

  // ─── Cancelar el cobro ───────────────────────────────────────────────

  /** El personal canceló el cobro: la factura abierta se cierra aquí y, si la clave deja, en BTCPay (si no, caduca). */
  async closeOnCancel(paymentId: string, tenantId: string): Promise<void> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.btcpayInvoice.findMany({ where: { paymentId, tenantId, status: { in: ['New', 'Processing'] } }, select: { id: true, invoiceId: true, tenantId: true } }),
    );
    if (rows.length === 0) return;
    const access = await this.stores.accessFor(tenantId);
    for (const r of rows) {
      await this.touch(r.id, { status: 'Invalid' });
      await this.invalidateInBtcpay(r, access);
    }
  }

  /**
   * Una factura ya cerrada aquí: se invalida en BTCPay si la clave deja y se da
   * por cerrada del todo. Si no (la clave no tiene ese permiso, BTCPay no
   * contesta), queda sin `closedAt`: el repaso la sigue mirando hasta que caduque
   * allí, y un pago que llegue entretanto acaba en Incidencias.
   */
  private async invalidateInBtcpay(row: { id: string; invoiceId: string; tenantId: string }, known?: BtcpayAccess | null): Promise<void> {
    const access = known === undefined ? await this.stores.accessFor(row.tenantId) : known;
    // Sin la conexión del local no hay a quién preguntar: nada que vigilar.
    if (!access) {
      await this.touch(row.id, { closedAt: new Date() });
      return;
    }
    try {
      if (await this.stores.clientFor(access).markInvalid(row.invoiceId)) {
        await this.touch(row.id, { closedAt: new Date() });
        return;
      }
      this.logger.log(`Factura ${row.invoiceId}: la clave no puede invalidarla; caducará sola (el repaso la sigue mirando)`);
    } catch (err) {
      this.logger.warn(`Factura ${row.invoiceId}: no se pudo invalidar en BTCPay (${(err as Error).message}); caducará sola (el repaso la sigue mirando)`);
    }
  }

  // ─── Lecturas ────────────────────────────────────────────────────────

  private async paymentByToken(key: string, by: 'token' | 'id' = 'token'): Promise<PaymentCtx> {
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: by === 'token' ? { qrToken: key } : { id: key },
        select: {
          id: true, tenantId: true, status: true, provider: true, providerTxId: true, amountCents: true,
          serviceFeeCents: true, currency: true, qrExpiresAt: true, walletId: true, createdByUserId: true,
        },
      }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    return { ...payment, serviceFeeCents: payment.serviceFeeCents ?? 0 };
  }

  /** Quien hizo el cobro o el encargado/dueño; el resto del local no. */
  private async paymentForStaff(paymentId: string, actor: StaffActor): Promise<PaymentCtx> {
    const payment = await this.paymentByToken(paymentId, 'id').catch(() => null);
    if (!payment || payment.tenantId !== actor.tenantId) throw new NotFoundException('Payment not found');
    const manager = actor.role === 'OWNER' || actor.role === 'MANAGER';
    if (!manager && payment.createdByUserId !== actor.userId) {
      throw new HttpException('Solo puedes ver el bitcoin de los cobros que has hecho tú', HttpStatus.FORBIDDEN);
    }
    return payment;
  }

  private async assertVenueCharges(tenantId: string): Promise<void> {
    const venue = await this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: tenantId }, select: VENUE_PAUSE_SELECT }));
    assertVenueNotPaused(venue);
  }

  private openInvoiceOf(paymentId: string): Promise<InvoiceRow | null> {
    return this.prisma.asSystem((tx) => tx.btcpayInvoice.findFirst({ where: { paymentId, status: { in: ['New', 'Processing'] } } }));
  }

  private latestInvoiceOf(paymentId: string): Promise<InvoiceRow | null> {
    return this.prisma.asSystem((tx) => tx.btcpayInvoice.findFirst({ where: { paymentId }, orderBy: { createdAt: 'desc' } }));
  }

  private async rowOrThrow(invoiceId: string): Promise<InvoiceRow> {
    const row = await this.prisma.asSystem((tx) => tx.btcpayInvoice.findUnique({ where: { invoiceId } }));
    if (!row) throw new NotFoundException('Invoice not found');
    return row;
  }

  private async touch(id: string, data: { status?: string; additionalStatus?: string | null; closedAt?: Date }): Promise<void> {
    await this.prisma.asSystem((tx) => tx.btcpayInvoice.update({ where: { id }, data: { ...data, lastCheckedAt: new Date() } }));
  }

  private async toView(row: InvoiceRow, paymentStatus: string): Promise<BtcpayInvoiceView> {
    const qr = await QRCode.toDataURL(row.qrLink, { errorCorrectionLevel: 'L', margin: 2, width: 520 });
    return {
      invoiceId: row.invoiceId,
      status: row.status as BtcpayInvoiceStatus,
      amountCents: row.amountCents,
      amountBtc: row.amountBtc,
      rate: row.rate,
      qrLink: row.qrLink,
      chainAddress: row.chainAddress,
      checkoutLink: row.checkoutLink,
      expiresAt: row.expiresAt.toISOString(),
      paymentStatus,
      qrImage: qr,
    };
  }
}
