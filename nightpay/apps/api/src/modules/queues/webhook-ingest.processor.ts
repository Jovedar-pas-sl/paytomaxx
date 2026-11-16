import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Provider } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import type { GatewayAdapter } from '../gateways/gateway.adapter';
import { parseWebhookBody } from '../gateways/header-utils';
import { InvalidTransitionError, isIdempotentTransition } from '../payments/payment.machine';
import { WEBHOOKS_INGEST_QUEUE } from './queue-tokens';
import { BtcpayInvoiceService } from '../btcpay/btcpay-invoice.service';
import {
  CARD_REFUNDED_AFTER_SALDO_EVENT,
  lateApprovalHandled,
  settleLateCardApproval,
  wasPaidWithSaldo,
} from '../payments/late-card-approval';
import { recordPaidAfterCancel } from '../payments/paid-after-cancel';
import {
  APPROVAL_UNBOOKED_EVENT,
  expectedCharge,
  judgeApproval,
  verdictDetail,
  type ApprovalVerdict,
} from './approval-check';

interface WebhookIngestJobData {
  deliveryId: string; // bigint as string
}

/** El cobro al que apunta el aviso. */
interface TargetPayment {
  id: string;
  tenantId: string;
  provider: Provider | null;
  amountCents: number;
  currency: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Procesa webhooks ya verificados (HMAC OK + idempotente).
 * Mapea el payload del provider a un evento FSM y aplica la transición.
 *
 * Un aviso "aprobado" no basta para dar un cobro por pagado: la pasarela
 * tiene que probarlo (firma del banco o consulta a su API) y el importe
 * tiene que ser el que se mandó al banco. Si no, no se toca el cobro y queda
 * una incidencia para el dueño. Lo mismo si el banco aprobó un cobro que aquí
 * ya no se puede dar por pagado (caducado, cancelado…): nunca se pierde en
 * silencio ni se agota en reintentos.
 */
// Tras un error de Redis, no esperar los 15 s por defecto para reanudar la cola.
// Hasta 4 avisos a la vez (por réplica): uno lento no frena a los demás, sin
// ocupar de golpe medio pool de la base (como INCIDENT_QUERY_CONCURRENCY). Es
// seguro: cada aviso tiene un solo trabajo (id fijo), el que ya está procesado
// no se repite, y transition() bloquea la fila del cobro (SELECT … FOR UPDATE):
// dos avisos del mismo cobro se ponen en fila; el segundo ve el cobro pagado
// (idempotente) o, si es otro pedido, lo apunta como doble cobro. El orden no
// importa: FAILED → AUTHORIZED se acepta y AUTHORIZED + FAILED se ignora.
@Processor(WEBHOOKS_INGEST_QUEUE, { runRetryDelay: 1000, concurrency: 4 })
export class WebhookIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookIngestProcessor.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly gateways: GatewayRegistry;
  /** Los avisos de BTCPay (bitcoin) los procesa BtcpayInvoiceService con la conexión de cada local. */
  private readonly btcpay: BtcpayInvoiceService | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
    @Optional() @Inject(BtcpayInvoiceService) btcpay?: BtcpayInvoiceService,
  ) {
    super();
    this.prisma = prisma;
    this.payments = payments;
    this.gateways = gateways;
    this.btcpay = btcpay ?? null;
  }

  async process(job: Job<WebhookIngestJobData>): Promise<void> {
    const { deliveryId } = job.data;

    // webhookDelivery NO esta en TENANT_SCOPED_MODELS — query directa sin asSystem.
    const delivery = await this.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: BigInt(deliveryId) },
    });

    if (delivery.processedAt) {
      this.logger.debug(`webhook ${deliveryId} already processed`);
      return;
    }

    // Bitcoin: el aviso no trae estado ni importe, se vuelve a pedir la factura a BTCPay.
    if (delivery.provider === 'BTCPAY') {
      if (!this.btcpay) throw new Error('Aviso de BTCPay sin el servicio de facturas de bitcoin');
      await this.btcpay.handleDelivery(delivery.tenantId, delivery.rawBody);
      await this.markProcessed(deliveryId);
      return;
    }

    const adapter = this.gateways.get(delivery.provider as Provider);
    // Redsys/Wipay se persisten form-urlencoded; Paytef/Peanpe como JSON.
    const parsed = parseWebhookBody(delivery.rawBody);
    const fsmEvent = adapter.mapWebhookToFsmEvent(parsed);

    if (!fsmEvent) {
      this.logger.warn(`webhook ${deliveryId}: unmappable event, skipping`);
      await this.markProcessed(deliveryId);
      return;
    }

    // Un aviso de una pasarela solo puede tocar cobros de esa pasarela: con el
    // secreto de la URL de Paytef (o un aviso de Peanpe) no se puede marcar
    // pagado un cobro de Redsys.
    const target = await this.findTarget(fsmEvent.paymentId, delivery.provider as Provider);
    if (!target || target.provider !== delivery.provider) {
      this.logger.warn(
        `webhook ${deliveryId}: el cobro ${fsmEvent.paymentId} no es de ${delivery.provider} (es ${target?.provider ?? 'desconocido'}) — ignorado`,
      );
      await this.markProcessed(deliveryId);
      return;
    }

    const { event } = fsmEvent;
    if (event.type === 'AUTHORIZED') {
      const verdict = await this.checkApproval(adapter, target, event.providerTxId, parsed);
      if (!verdict.ok) {
        await this.recordAndClose(deliveryId, target, verdict.eventType, {
          provider: target.provider,
          providerTxId: event.providerTxId,
          ...verdictDetail(verdict),
        });
        return;
      }
    }

    try {
      // Defensa cross-tenant: si el delivery trae tenantId (lo setea
      // webhooks.controller al validar el webhook), lo pasamos a transition
      // para que rechace payments que no pertenezcan a ese venue. El
      // externalEventId del payload del provider no debe poder mutar payments
      // de otro tenant.
      await this.payments.transition(target.id, event, delivery.tenantId ?? undefined);
      await this.markProcessed(deliveryId);
      this.logger.log(`webhook ${deliveryId} → payment ${target.id} transitioned`);
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      if (isIdempotentTransition(err)) {
        // Idempotencia válida (e.g. webhook duplicado, AUTHORIZED→AUTHORIZED)
        this.logger.debug(
          `webhook ${deliveryId}: transition idempotente (${err.fromState} + ${err.eventType}) — ya en estado destino`,
        );
        await this.markProcessed(deliveryId);
        return;
      }
      if (event.type === 'AUTHORIZED' && err.fromState === 'CANCELED' && (await wasPaidWithSaldo(this.prisma, target.id))) {
        // Cobro único: el cliente ya lo pagó con su saldo y el banco aprobó
        // también la tarjeta. Se devuelve solo si la pasarela puede; si no,
        // incidencia «cobrado dos veces». Un aviso repetido no lo hace dos veces.
        if (await lateApprovalHandled(this.prisma, target.id, event.providerTxId)) {
          await this.markProcessed(deliveryId);
          return;
        }
        const outcome = await settleLateCardApproval(
          { prisma: this.prisma, adapter, logger: this.logger },
          target,
          event.providerTxId,
        );
        await this.recordAndClose(deliveryId, target, outcome.eventType, outcome.payload);
        return;
      }
      if (event.type === 'AUTHORIZED' && err.fromState === 'CANCELED') {
        // Pagó después de cancelar (el personal canceló con el cliente en su
        // banco): sigue CANCELED, sin devolverlo solo; una incidencia por
        // pedido aunque el aviso se repita (paid-after-cancel.ts).
        await recordPaidAfterCancel(
          { prisma: this.prisma, logger: this.logger },
          target,
          { provider: target.provider, providerTxId: event.providerTxId, source: 'aviso', deliveryId },
        );
        return;
      }
      if (event.type === 'AUTHORIZED') {
        // El banco cobró y el cobro ya no se puede dar por pagado (caducado,
        // cancelado, nunca fue al banco…). Reintentar no lo arregla: se
        // apunta como incidencia para devolverlo o cobrarlo a mano.
        await this.recordAndClose(deliveryId, target, APPROVAL_UNBOOKED_EVENT, {
          provider: target.provider,
          providerTxId: event.providerTxId,
          fromStatus: err.fromState,
        });
        return;
      }
      // Bug real: estado del payment incompatible con el evento (mapeo
      // cruzado, carrera con otro flujo…). NO marcamos como procesado — dejamos
      // que BullMQ reintente y los reintentos agotados queden visibles.
      this.logger.error(
        `webhook ${deliveryId}: transition INESPERADA — payment ${target.id} está en ${err.fromState}, evento ${err.eventType}. NO marcando processed, reintentos exhaustos quedarán visibles.`,
      );
      throw err;
    }
  }

  /**
   * El cobro que nombra el aviso: por su id o por el de uno de sus intentos.
   * Paytef (clientID) y Cecabank (Num_operacion) llevan el id del intento: la
   * página del banco la ve el cliente, y del id del cobro sale el código de
   * confirmación (FSD-02). Los avisos de antes nombran el cobro. Un intento
   * de otra pasarela no cuenta.
   */
  private async findTarget(ref: string, provider: Provider): Promise<TargetPayment | null> {
    // Un id que no es UUID (aviso raro o manipulado) no es ningún cobro: sin
    // esto la consulta falla y el aviso se reintenta 5 veces para nada.
    if (!UUID_RE.test(ref)) return null;
    const select = { id: true, tenantId: true, provider: true, amountCents: true, currency: true } as const;
    // Sin local en el contexto (es un trabajo, no una petición): lectura de sistema.
    return this.prisma.asSystem(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: ref }, select });
      if (payment) return payment;
      const attempt = await tx.paymentAttempt.findUnique({ where: { id: ref }, select: { paymentId: true, provider: true } });
      if (!attempt || attempt.provider !== provider) return null;
      return tx.payment.findUnique({ where: { id: attempt.paymentId }, select });
    });
  }

  /**
   * Prueba de la pasarela + importe del intento. Si la pasarela no responde
   * ahora, lanza: BullMQ reintenta (y si no, la conciliación del cobro sigue).
   */
  private async checkApproval(
    adapter: GatewayAdapter,
    target: TargetPayment,
    providerTxId: string,
    payload: Record<string, unknown>,
  ): Promise<ApprovalVerdict> {
    // El intento de ese pedido: su importe (lo mandado al banco) y su id
    // (Paytef lo lleva como clientID del enlace).
    const attempt = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findFirst({
        where: { paymentId: target.id, provider: adapter.provider, providerTxId },
        select: { id: true, amountCents: true },
      }),
    );
    const proof = await adapter.proveApproval({
      paymentId: target.id,
      providerTxId,
      payload,
      ...(attempt?.id ? { attemptId: attempt.id } : {}),
    });
    if (proof.kind === 'unavailable') {
      throw new Error(`no se pudo comprobar la aprobación con ${adapter.provider}: ${proof.reason}`);
    }
    return judgeApproval(proof, expectedCharge(target, attempt));
  }

  /**
   * Apunta la incidencia (payment_events) y da el aviso por procesado en la
   * misma transacción: si algo falla, ni una cosa ni la otra (se reintenta
   * sin duplicar la incidencia).
   */
  private async recordAndClose(
    deliveryId: string,
    target: TargetPayment,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (eventType === CARD_REFUNDED_AFTER_SALDO_EVENT) {
      this.logger.warn(`webhook ${deliveryId}: tarjeta aprobada tras pagar con saldo en el cobro ${target.id} — devuelta sola`);
    } else {
      this.logger.error(
        `webhook ${deliveryId}: ${eventType} en el cobro ${target.id} — no se da por pagado, queda en Incidencias (${JSON.stringify(payload)})`,
      );
    }
    await this.prisma.asSystem(async (tx) => {
      await tx.paymentEvent.create({
        data: {
          paymentId: target.id,
          tenantId: target.tenantId,
          eventType,
          payload: { ...payload, deliveryId },
          traceId: randomUUID(),
        },
      });
      await tx.webhookDelivery.update({
        where: { id: BigInt(deliveryId) },
        data: { processedAt: new Date() },
      });
    });
  }

  private async markProcessed(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: BigInt(deliveryId) },
      data: { processedAt: new Date() },
    });
  }
}
