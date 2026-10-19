import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { QrExpireProcessor } from './qr-expire.processor';
import { InvalidTransitionError } from '../payments/payment.machine';
import type { LockedPaymentRow, TransitionOptions } from '../payments/payments.service';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';

/** transition() de mentira: llama a prepare con la fila bloqueada en `status`. */
function makeProcessor(status: string, fails?: Error) {
  const payments = {
    transition: vi.fn(async (_id: string, _event: unknown, _tenant: unknown, opts?: TransitionOptions) => {
      if (fails) throw fails;
      await opts?.prepare?.({} as never, { status } as LockedPaymentRow);
    }),
  };
  const processor = new QrExpireProcessor(payments as never);
  const job = { data: { paymentId: PAYMENT_ID, tenantId: 't-1' } } as Job<{ paymentId: string; tenantId: string }>;
  return { processor, payments, job };
}

describe('QrExpireProcessor — solo caduca lo que no ha ido al banco (P2)', () => {
  it.each(['CREATED', 'AWAITING_CAPTURE'])('%s → TIMEOUT (EXPIRED)', async (status) => {
    const m = makeProcessor(status);
    await expect(m.processor.process(m.job)).resolves.toBeUndefined();
    expect(m.payments.transition).toHaveBeenCalledWith(PAYMENT_ID, { type: 'TIMEOUT' }, undefined, expect.any(Object));
  });

  it('AUTHORIZING (cliente en 3D Secure): no pasa a ORPHAN; se rechaza con la fila bloqueada', async () => {
    const m = makeProcessor('AUTHORIZING');
    await expect(m.processor.process(m.job)).resolves.toBeUndefined();
    const prepare = m.payments.transition.mock.calls[0]![3]!.prepare!;
    await expect(prepare({} as never, { status: 'AUTHORIZING' } as LockedPaymentRow)).rejects.toMatchObject({
      fromState: 'AUTHORIZING',
      eventType: 'TIMEOUT',
    });
  });

  it('ya pagado o caducado: nada que hacer, sin error', async () => {
    const m = makeProcessor('AUTHORIZED', new InvalidTransitionError('AUTHORIZED', 'TIMEOUT'));
    await expect(m.processor.process(m.job)).resolves.toBeUndefined();
  });

  it('otro error (base caída) se propaga para que BullMQ reintente', async () => {
    const m = makeProcessor('CREATED', new Error('db caída'));
    await expect(m.processor.process(m.job)).rejects.toThrow('db caída');
  });
});
