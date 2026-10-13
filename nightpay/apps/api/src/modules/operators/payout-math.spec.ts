import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAYOUT_HOLD_DAYS,
  earningNetCents,
  parseHoldDays,
  payoutCutoff,
  payoutTotalCents,
} from './payout-math';

describe('payout-math', () => {
  it('neto de un earning = comisión + propina − devuelto', () => {
    expect(earningNetCents({ commissionCents: 9000, tipCents: 500, reversedCents: 900 })).toBe(8600);
    expect(earningNetCents({ commissionCents: 9000, tipCents: null, reversedCents: 0 })).toBe(9000);
  });

  it('el pago descuenta la deuda por devoluciones tras un pago anterior', () => {
    const total = payoutTotalCents(
      [
        { commissionCents: 9000, tipCents: 0, reversedCents: 0 },
        { commissionCents: 4500, tipCents: 500, reversedCents: 0 },
      ],
      [{ reversedDeltaCents: 9000 }],
    );
    expect(total).toBe(5000);
  });

  it('la deuda puede dejar el total en negativo (no hay nada que pagar)', () => {
    expect(
      payoutTotalCents([{ commissionCents: 1000, tipCents: 0, reversedCents: 0 }], [{ reversedDeltaCents: 9000 }]),
    ).toBe(-8000);
  });

  it('fecha límite = ahora − días de espera', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    expect(payoutCutoff(now, 7).toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(payoutCutoff(now, 0).toISOString()).toBe(now.toISOString());
  });

  it('PAYOUT_HOLD_DAYS inválido o ausente → 7 días', () => {
    expect(parseHoldDays(undefined)).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
    expect(parseHoldDays('abc')).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
    expect(parseHoldDays('-1')).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
    expect(parseHoldDays('3')).toBe(3);
  });
});
