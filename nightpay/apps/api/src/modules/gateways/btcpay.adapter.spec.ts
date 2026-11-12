import { describe, it, expect } from 'vitest';
import { BtcpayAdapter } from './btcpay.adapter';
import { GatewayRegistry } from './gateway.registry';

describe('BtcpayAdapter', () => {
  const adapter = new BtcpayAdapter();

  it('es la pasarela BTCPAY', () => {
    expect(adapter.provider).toBe('BTCPAY');
  });

  it('refund lanza como las otras pasarelas que devuelven fuera', async () => {
    await expect(adapter.refund({ tenantId: 't', paymentId: 'p', providerTxId: 'i', amountCents: 100, reference: 'r' } as never)).rejects.toThrow(/devuelto fuera|cartera/i);
  });

  it('nunca da una aprobación por probada ni mapea avisos por la ruta genérica', async () => {
    expect((await adapter.proveApproval({ paymentId: 'p', providerTxId: 'i', payload: {} })).kind).not.toBe('confirmed');
    expect(adapter.verifyWebhook().valid).toBe(false);
    expect(adapter.mapWebhookToFsmEvent()).toBeNull();
    expect(await adapter.getStatus('t', 'i')).toBe('UNKNOWN');
  });

  it('el registro la entrega si está, y las specs de antes (4 pasarelas) siguen valiendo', () => {
    const four = new GatewayRegistry({} as never, {} as never, {} as never, {} as never);
    expect(() => four.get('BTCPAY')).toThrow(/No gateway adapter/);
    const five = new GatewayRegistry({} as never, {} as never, {} as never, {} as never, adapter);
    expect(five.get('BTCPAY')).toBe(adapter);
  });
});
