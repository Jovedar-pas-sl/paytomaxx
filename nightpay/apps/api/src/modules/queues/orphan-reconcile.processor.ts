import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PaymentsService } from '../payments/payments.service';
import { GatewayRegistry } from '../gateways/gateway.registry';
import { ORPHAN_RECONCILE_QUEUE } from './queue-tokens';
import { InvalidTransitionError } from '../payments/payment.machine';

interface OrphanReconcileJobData {
  paymentId: string;
  tenantId: string;
}

/**
 * Saga de compensación: cuando un pago lleva 30+ min en AUTHORIZING sin webhook,
 * consultamos a la pasarela el estado real y resolvemos.
 */
@Processor(ORPHAN_RECONCILE_QUEUE)
export class OrphanReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(OrphanReconcileProcessor.name);
  private readonly payments: PaymentsService;
  private readonly gateways: GatewayRegistry;

  constructor(
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(GatewayRegistry) gateways: GatewayRegistry,
  ) {
    super();
    this.payments = payments;
    this.gateways = gateways;
  }

  async process(job: Job<OrphanReconcileJobData>): Promise<void> {
    const { paymentId, tenantId } = job.data;

    const payment = await this.payments.findById(paymentId);
    if (!payment.providerTxId || !payment.provider) {
      this.logger.warn(`Orphan ${paymentId} has no providerTxId — marking FAILED`);
      try {
        await this.payments.transition(paymentId, {
          type: 'FAILED',
          reason: 'orphan-without-provider-tx',
        });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }
      return;
    }

    const adapter = this.gateways.get(payment.provider);
    const realStatus = await adapter.getStatus(tenantId, payment.providerTxId);

    try {
      if (realStatus === 'AUTHORIZED') {
        await this.payments.transition(paymentId, {
          type: 'AUTHORIZED',
          providerTxId: payment.providerTxId,
          provider: payment.provider,
        });
        this.logger.log(`Orphan resolved → AUTHORIZED: ${paymentId}`);
      } else if (realStatus === 'FAILED') {
        await this.payments.transition(paymentId, {
          type: 'FAILED',
          reason: 'orphan-resolved-failed',
        });
        this.logger.log(`Orphan resolved → FAILED: ${paymentId}`);
      } else {
        // Aún processing → reencolar con backoff
        this.logger.warn(`Orphan ${paymentId} still pending (gateway=${realStatus}) — re-queueing`);
        throw new Error('still-pending');
      }
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.logger.debug(`Orphan transition rejected (likely race): ${paymentId}`);
        return;
      }
      throw err;
    }
  }
}
