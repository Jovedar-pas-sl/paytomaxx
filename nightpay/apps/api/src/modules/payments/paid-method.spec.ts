import { describe, expect, it } from 'vitest';
import { paidMethodOf } from './paid-method';

describe('cómo pagó (el PAGADO del personal)', () => {
  it('con BTCPay es bitcoin, lo diga o no el intento que cobró', () => {
    expect(paidMethodOf('BTCPAY', 'bitcoin')).toBe('bitcoin');
    expect(paidMethodOf('BTCPAY', null)).toBe('bitcoin');
    expect(paidMethodOf(null, 'bitcoin')).toBe('bitcoin');
  });

  it('con el banco, lo que dio el banco: tarjeta o Apple Pay / Google Pay', () => {
    expect(paidMethodOf('REDSYS', 'card')).toBe('card');
    expect(paidMethodOf('REDSYS', 'wallet')).toBe('wallet');
  });

  it('sin saberlo (datáfono, cobro de antes, valor raro): nada', () => {
    expect(paidMethodOf('PAYTEF', null)).toBeNull();
    expect(paidMethodOf('REDSYS', 'otro')).toBeNull();
    expect(paidMethodOf(null, null)).toBeNull();
  });
});
