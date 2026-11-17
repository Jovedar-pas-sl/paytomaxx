import { describe, expect, it } from 'vitest';
import { canCashRefund, cashGoesToOwner, cashMaxCents } from './bitcoin-cash';

const NOW = Date.parse('2026-11-17T01:00:00Z');
const on = { enabled: true, approvalAboveCents: 10_000, days: 7, maxCents: 99_999 };
const paid = { provider: 'BTCPAY', status: 'AUTHORIZED', availableAmountCents: 4_500, walletId: null, authorizedAt: '2026-11-16T23:00:00Z' };

describe('«Devolver en efectivo» lo pagado con bitcoin', () => {
  it('sale en un cobro pagado con bitcoin, para el encargado y el dueño, con el interruptor encendido y en plazo', () => {
    expect(canCashRefund(paid, 'MANAGER', on, NOW)).toBe(true);
    expect(canCashRefund(paid, 'OWNER', on, NOW)).toBe(true);
  });

  it('no sale: apagado, camarero o recepción, tarjeta, recarga, devuelto del todo o pasados 7 días', () => {
    expect(canCashRefund(paid, 'MANAGER', { ...on, enabled: false }, NOW)).toBe(false);
    expect(canCashRefund(paid, 'MANAGER', null, NOW)).toBe(false);
    expect(canCashRefund(paid, 'WAITER', on, NOW)).toBe(false);
    expect(canCashRefund({ ...paid, provider: 'REDSYS' }, 'OWNER', on, NOW)).toBe(false);
    expect(canCashRefund({ ...paid, walletId: 'w' }, 'OWNER', on, NOW)).toBe(false);
    expect(canCashRefund({ ...paid, availableAmountCents: 0 }, 'OWNER', on, NOW)).toBe(false);
    expect(canCashRefund({ ...paid, authorizedAt: '2026-11-09T00:00:00Z' }, 'OWNER', on, NOW)).toBe(false);
  });

  it('pasa al dueño cuando supera su umbral contando lo ya devuelto; el dueño, nunca', () => {
    expect(cashGoesToOwner(on, 0, 10_000)).toBe(false);
    expect(cashGoesToOwner(on, 6_000, 5_000)).toBe(true);
    expect(cashGoesToOwner({ ...on, approvalAboveCents: null }, 90_000, 9_000)).toBe(false);
    expect(cashMaxCents(on, 150_000)).toBe(99_999);
    expect(cashMaxCents(on, 4_500)).toBe(4_500);
  });
});
