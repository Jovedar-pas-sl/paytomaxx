import { describe, it, expect } from 'vitest';
import { isPayoutRequested } from './payout-request';

describe('pagar a la chica: ¿pagado o pedido al dueño?', () => {
  it('202 «pedido al dueño»', () => {
    expect(
      isPayoutRequested({
        approvalRequestId: '3f2b6a3e-0000-4000-8000-000000000001',
        status: 'PENDING',
        kind: 'PAYOUT',
        amountCents: 9000,
        message: 'Pedido al dueño: lo aprueba en «Por aprobar».',
      }),
    ).toBe(true);
  });

  it('201 pagado (o cualquier otra cosa) no lo es', () => {
    expect(isPayoutRequested({ id: 'p', totalCents: 9000, earningCount: 1, createdAt: '2026-10-16T01:00:00Z' })).toBe(false);
    expect(isPayoutRequested(null)).toBe(false);
    expect(isPayoutRequested({ approvalRequestId: 'x', status: 'APPROVED', amountCents: 1, message: '' })).toBe(false);
  });
});
