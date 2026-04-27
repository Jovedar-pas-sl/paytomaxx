import { describe, it, expect } from 'vitest';
import { applyEvent, type PaymentContext } from './payment.machine';

const baseCtx = (over: Partial<PaymentContext> = {}): PaymentContext => ({
  paymentId: 'p1',
  amountCents: 4850,
  availableAmountCents: 4850,
  ...over,
});

describe('paymentMachine', () => {
  it('CREATED + QR_VIEWED → AWAITING_CAPTURE', () => {
    const r = applyEvent('CREATED', baseCtx(), { type: 'QR_VIEWED' });
    expect(r?.nextState).toBe('AWAITING_CAPTURE');
  });

  it('CREATED + TIMEOUT → EXPIRED', () => {
    const r = applyEvent('CREATED', baseCtx(), { type: 'TIMEOUT' });
    expect(r?.nextState).toBe('EXPIRED');
  });

  it('AUTHORIZING + AUTHORIZED persists providerTxId', () => {
    const r = applyEvent('AUTHORIZING', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'TX-1',
      provider: 'WIPAY',
    });
    expect(r?.nextState).toBe('AUTHORIZED');
    expect(r?.nextContext.providerTxId).toBe('TX-1');
    expect(r?.nextContext.provider).toBe('WIPAY');
  });

  it('AUTHORIZING + TIMEOUT → ORPHAN', () => {
    const r = applyEvent('AUTHORIZING', baseCtx(), { type: 'TIMEOUT' });
    expect(r?.nextState).toBe('ORPHAN');
  });

  it('ORPHAN + AUTHORIZED → AUTHORIZED', () => {
    const r = applyEvent('ORPHAN', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'TX-2',
      provider: 'PEANPE',
    });
    expect(r?.nextState).toBe('AUTHORIZED');
  });

  it('AUTHORIZED + REFUND_PARTIAL (parcial) → PARTIALLY_REFUNDED', () => {
    const r = applyEvent('AUTHORIZED', baseCtx({ availableAmountCents: 4850 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 1200,
    });
    expect(r?.nextState).toBe('PARTIALLY_REFUNDED');
    expect(r?.nextContext.availableAmountCents).toBe(3650);
  });

  it('AUTHORIZED + REFUND_PARTIAL que cubre todo → REFUNDED', () => {
    const r = applyEvent('AUTHORIZED', baseCtx({ availableAmountCents: 4850 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 4850,
    });
    expect(r?.nextState).toBe('REFUNDED');
  });

  it('PARTIALLY_REFUNDED + REFUND_PARTIAL adicional → PARTIALLY_REFUNDED', () => {
    const r = applyEvent('PARTIALLY_REFUNDED', baseCtx({ availableAmountCents: 3650 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 1000,
    });
    expect(r?.nextState).toBe('PARTIALLY_REFUNDED');
    expect(r?.nextContext.availableAmountCents).toBe(2650);
  });

  it('FAILED es terminal — REFUND_PARTIAL no transiciona', () => {
    const r = applyEvent('FAILED', baseCtx(), { type: 'REFUND_PARTIAL', amountCents: 100 });
    expect(r).toBeNull();
  });

  it('CREATED + AUTHORIZED es transición ilegal', () => {
    const r = applyEvent('CREATED', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'X',
      provider: 'WIPAY',
    });
    expect(r).toBeNull();
  });

  it('EXPIRED + cualquier cosa → null (terminal)', () => {
    const r = applyEvent('EXPIRED', baseCtx(), { type: 'AUTHORIZING' });
    expect(r).toBeNull();
  });
});
