import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PaymentsService } from '../payments/payments.service';
import { InvalidTransitionError, type PaymentMachineState } from '../payments/payment.machine';
import { QR_EXPIRE_QUEUE } from './queue-tokens';

interface QrExpireJobData {
  paymentId: string;
  tenantId: string;
}

/** Lo único que caduca el QR: cobros que aún no han ido al banco. */
const EXPIRABLE: ReadonlySet<PaymentMachineState> = new Set<PaymentMachineState>(['CREATED', 'AWAITING_CAPTURE']);

/**
 * Worker que dispara TIMEOUT cuando el QR expira (5 min sin escanear).
 * - Si está CREATED/AWAITING_CAPTURE → pasa a EXPIRED.
 * - Cualquier otro estado → no se toca. En particular AUTHORIZING: el cliente
 *   puede estar aún en 3D Secure. Antes pasaba a ORPHAN a los 5 min y salía en
 *   Incidencias para resolverlo a mano mientras el banco todavía podía cobrar;
 *   de un AUTHORIZING sin aviso se encarga la conciliación (orphan-reconcile).
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
    const expired = await expireIfStillOpen(this.payments, paymentId);
    if (expired) this.logger.log(`QR expired: ${paymentId}`);
    else this.logger.debug(`qr-expire ignored: ${paymentId}`);
  }
}

/**
 * Caduca el cobro si aún no ha ido al banco (true) o no hace nada (false: ya
 * pagado, en el banco o caducado). El estado se mira con la fila bloqueada
 * (prepare), no antes: si el cliente empieza a pagar justo ahora, no se
 * caduca. Otro error (base caída) se propaga. Lo usan el trabajo y el barrido.
 */
export async function expireIfStillOpen(payments: Pick<PaymentsService, 'transition'>, paymentId: string): Promise<boolean> {
  try {
    await payments.transition(paymentId, { type: 'TIMEOUT' }, undefined, {
      prepare: async (_tx, locked) => {
        if (!EXPIRABLE.has(locked.status)) throw new InvalidTransitionError(locked.status, 'TIMEOUT');
      },
    });
    return true;
  } catch (err) {
    if (err instanceof InvalidTransitionError) return false;
    throw err;
  }
}
