import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
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
@Processor(WEBHOOKS_INGEST_QUEUE)
export class WebhookIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookIngestProcessor.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly gateways: GatewayRegistry;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
  ) {
    super();
    this.prisma = prisma;
    this.payments = payments;
    this.gateways = gateways;
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
    const target = await this.findTarget(fsmEvent.paymentId);
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
      await this.payments.transition(fsmEvent.paymentId, event, delivery.tenantId ?? undefined);
      await this.markProcessed(deliveryId);
      this.logger.log(`webhook ${deliveryId} → payment ${fsmEvent.paymentId} transitioned`);
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
        `webhook ${deliveryId}: transition INESPERADA — payment ${fsmEvent.paymentId} está en ${err.fromState}, evento ${err.eventType}. NO marcando processed, reintentos exhaustos quedarán visibles.`,
      );
      throw err;
    }
  }

  private async findTarget(paymentId: string): Promise<TargetPayment | null> {
    // Un id que no es UUID (aviso raro o manipulado) no es ningún cobro: sin
    // esto la consulta falla y el aviso se reintenta 5 veces para nada.
    if (!UUID_RE.test(paymentId)) return null;
    // Sin local en el contexto (es un trabajo, no una petición): lectura de sistema.
    return this.prisma.asSystem((tx) =>
      tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, tenantId: true, provider: true, amountCents: true, currency: true },
      }),
    );
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
    const proof = await adapter.proveApproval({ paymentId: target.id, providerTxId, payload });
    if (proof.kind === 'unavailable') {
      throw new Error(`no se pudo comprobar la aprobación con ${adapter.provider}: ${proof.reason}`);
    }
    const attempt = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findFirst({
        where: { paymentId: target.id, provider: adapter.provider, providerTxId },
        select: { amountCents: true },
      }),
    );
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
    this.logger.error(
      `webhook ${deliveryId}: ${eventType} en el cobro ${target.id} — no se da por pagado, queda en Incidencias (${JSON.stringify(payload)})`,
    );
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
