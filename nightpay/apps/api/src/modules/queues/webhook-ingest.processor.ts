import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { parseWebhookBody } from '../gateways/header-utils';
import { InvalidTransitionError, isIdempotentTransition } from '../payments/payment.machine';
import { WEBHOOKS_INGEST_QUEUE } from './queue-tokens';
import type { Provider } from '@nightpay/contracts';

interface WebhookIngestJobData {
  deliveryId: string; // bigint as string
}

/**
 * Procesa webhooks ya verificados (HMAC OK + idempotente).
 * Mapea el payload del provider a un evento FSM y aplica la transición.
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

    try {
      // Defensa cross-tenant: si el delivery trae tenantId (lo setea
      // webhooks.controller al validar el webhook), lo pasamos a transition
      // para que rechace payments que no pertenezcan a ese venue. El
      // externalEventId del payload del provider no debe poder mutar payments
      // de otro tenant.
      await this.payments.transition(
        fsmEvent.paymentId,
        fsmEvent.event,
        delivery.tenantId ?? undefined,
      );
      await this.markProcessed(deliveryId);
      this.logger.log(`webhook ${deliveryId} → payment ${fsmEvent.paymentId} transitioned`);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        if (isIdempotentTransition(err)) {
          // Idempotencia válida (e.g. webhook duplicado, AUTHORIZED→AUTHORIZED)
          this.logger.debug(
            `webhook ${deliveryId}: transition idempotente (${err.fromState} + ${err.eventType}) — ya en estado destino`,
          );
          await this.markProcessed(deliveryId);
          return;
        }
        // Bug real: estado del payment incompatible con el evento. Podría ser:
        //  - Replay de webhook viejo cuando ya EXPIRED (filtrado por isIdempotent)
        //  - Bug en mapWebhookToFsmEvent (paymentId resuelto mal)
        //  - Estado inesperado por race con otro flow
        // NO marcamos como procesado — dejamos que BullMQ reintente y/o que
        // monitoring nos avise vía métrica.
        this.logger.error(
          `webhook ${deliveryId}: transition INESPERADA — payment ${fsmEvent.paymentId} está en ${err.fromState}, evento ${err.eventType}. NO marcando processed, reintentos exhaustos quedarán visibles.`,
        );
        throw err;
      }
      throw err;
    }
  }

  private async markProcessed(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: BigInt(deliveryId) },
      data: { processedAt: new Date() },
    });
  }
}
