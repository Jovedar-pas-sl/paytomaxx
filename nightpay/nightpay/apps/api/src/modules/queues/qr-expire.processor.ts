import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError } from '../payments/payment.machine';
import { QR_EXPIRE_QUEUE } from './queue-tokens';

interface QrExpireJobData {
  paymentId: string;
  tenantId: string;
}

/**
 * Worker que dispara TIMEOUT cuando el QR expira (5 min sin escanear).
 * - Si el pago ya está AUTHORIZED/FAILED/etc → la transición FSM lo rechaza y
 *   el job termina silenciosamente. No hay nada que hacer.
 * - Si está CREATED/AWAITING_CAPTURE → pasa a EXPIRED.
 * - Si está AUTHORIZING (raro) → pasa a ORPHAN, el saga reconcile-orphan
 *   resolverá luego.
 */
@Processor(QR_EXPIRE_QUEUE)
export class QrExpireProcessor extends WorkerHost {
  private readonly logger = new Logger(QrExpireProcessor.name);
  private readonly payments: PaymentsService;

  constructor(@Inject(PaymentsService) payments: PaymentsService) {
    super();
    this.payments = payments;
  }

  async process(job: Job<QrExpireJobData>): Promise<void> {
    const { paymentId } = job.data;
    try {
      await this.payments.transition(paymentId, { type: 'TIMEOUT' });
      this.logger.log(`QR expired: ${paymentId}`);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        // Pago ya en estado terminal — nada que hacer
        this.logger.debug(`qr-expire ignored (terminal state): ${paymentId}`);
        return;
      }
      throw err;
    }
  }
}
