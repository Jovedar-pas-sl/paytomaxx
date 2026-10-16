import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAYOUT_HOLD_DAYS,
  availableCentsOf,
  earningNetCents,
  payableSummary,
  parseHoldDays,
  payoutCutoff,
  payoutTotalCents,
  resolveHoldDays,
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

  it('días de espera del local: los suyos (0 incluido) o, si son null o no valen, PAYOUT_HOLD_DAYS', () => {
    expect(resolveHoldDays(0, '7')).toBe(0);
    expect(resolveHoldDays(2, '7')).toBe(2);
    expect(resolveHoldDays(60, '7')).toBe(60);
    expect(resolveHoldDays(null, '3')).toBe(3);
    expect(resolveHoldDays(undefined, undefined)).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
    // Fuera de rango o no entero (no debería pasar: CHECK en la base): el del entorno.
    expect(resolveHoldDays(61, '3')).toBe(3);
    expect(resolveHoldDays(-1, '3')).toBe(3);
    expect(resolveHoldDays(1.5, '3')).toBe(3);
  });

  it('disponible para pagar = no pagado − en espera − deuda (como el saldo de la chica)', () => {
    expect(availableCentsOf({ unpaidCents: 12_000, heldCents: 3_000, debtCents: 1_000 })).toBe(8_000);
    expect(availableCentsOf({ unpaidCents: 1_000, heldCents: 0, debtCents: 9_000 })).toBe(-8_000);
    // Un "en espera" negativo (devoluciones de algo aún en espera) no suma.
    expect(availableCentsOf({ unpaidCents: 500, heldCents: -200, debtCents: 0 })).toBe(500);
  });

  it('lo que hay que pagar ya: la deuda de una chica no resta a las demás; en espera y deuda aparte', () => {
    const s = payableSummary([
      { unpaidCents: 12_000, heldCents: 3_000, debtCents: 1_000 }, // 8.000 a pagar
      { unpaidCents: 1_000, heldCents: 0, debtCents: 9_000 }, // debe: 0
      { unpaidCents: 4_000, heldCents: 4_000, debtCents: 0 }, // todo en espera: 0
    ]);
    expect(s).toEqual({ payableCents: 8_000, operatorCount: 1, heldCents: 7_000, debtCents: 10_000 });
  });
});
