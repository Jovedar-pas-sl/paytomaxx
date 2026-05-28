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
 * Saga de compensación: cuando un pago lleva tiempo en AUTHORIZING sin webhook,
 * consultamos a la pasarela el estado real y resolvemos.
 *
 * Política de reintentos: si la pasarela devuelve UNKNOWN repetidamente
 * (red caída, consulta no autorizada por el banco — SIS0105 — etc), tras
 * agotar reintentos transicionamos a ORPHAN (estado terminal-resoluble).
 * ORPHAN es visible en admin para reconciliar a mano. NO se queda
 * AUTHORIZING para siempre.
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
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

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
        return;
      }
      if (realStatus === 'FAILED') {
        await this.payments.transition(paymentId, {
          type: 'FAILED',
          reason: 'orphan-resolved-failed',
        });
        this.logger.log(`Orphan resolved → FAILED: ${paymentId}`);
        return;
      }
      // realStatus === 'UNKNOWN' — la pasarela no nos puede confirmar.
      // Si quedan intentos, dejamos que BullMQ reintente con backoff.
      // Si agotamos intentos, marcamos ORPHAN (visible en admin para
      // reconciliación manual).
      if (attempt < maxAttempts) {
        this.logger.warn(
          `Orphan ${paymentId} still pending (gateway=UNKNOWN) — retry ${attempt}/${maxAttempts}`,
        );
        throw new Error('still-pending');
      }
      this.logger.warn(
        `Orphan ${paymentId} reintentos agotados (${maxAttempts}) — transición a ORPHAN para reconciliación manual`,
      );
      try {
        await this.payments.transition(paymentId, { type: 'TIMEOUT' });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
        // Race: webhook llegó y avanzó el FSM mientras nosotros marcábamos
        // ORPHAN. Está bien, el otro path ganó.
        this.logger.debug(`Orphan ${paymentId} ya transicionó — race con webhook`);
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
