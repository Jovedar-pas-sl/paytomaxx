import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_PAYOUT_HOLD_DAYS,
  availableCentsOf,
  earningNetCents,
  parseHoldDays,
  payableSummary,
  payoutTotalCents,
  resolveHoldDays,
} from './payout-math';
import { venueHoldDays } from './venue-hold-days';
import { payoutRoutingChanges } from './payout-routing';

const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const IBAN = 'ES9121000418450200051332';

describe('payout-math — casos límite del dinero de las chicas', () => {
  it('una comisión devuelta de más (devolución mayor que comisión + propina) resta', () => {
    expect(earningNetCents({ commissionCents: 4_500, tipCents: 0, reversedCents: 5_000 })).toBe(-500);
  });

  it('solo deuda, sin comisiones: el total es la deuda en negativo', () => {
    expect(payoutTotalCents([], [{ reversedDeltaCents: 2_500 }, { reversedDeltaCents: 1_000 }])).toBe(-3_500);
    expect(payoutTotalCents([], [])).toBe(0);
  });

  it('todo en espera: disponible 0; en espera mayor que lo no pagado → negativo', () => {
    expect(availableCentsOf({ unpaidCents: 6_000, heldCents: 6_000, debtCents: 0 })).toBe(0);
    expect(availableCentsOf({ unpaidCents: 6_000, heldCents: 7_500, debtCents: 0 })).toBe(-1_500);
  });

  it('tesorería sin chicas: todo a cero; un "en espera" negativo no resta del total en espera', () => {
    expect(payableSummary([])).toEqual({ payableCents: 0, operatorCount: 0, heldCents: 0, bankHeldCents: 0, debtCents: 0 });
    expect(payableSummary([{ unpaidCents: 1_000, heldCents: -400, debtCents: 0 }]).heldCents).toBe(0);
  });
});

describe('Días de espera — PAYOUT_HOLD_DAYS y regla del local', () => {
  it('PAYOUT_HOLD_DAYS ya convertido a número (config validada) vale tal cual', () => {
    expect(parseHoldDays(3)).toBe(3);
    expect(parseHoldDays(0)).toBe(0);
    expect(parseHoldDays('0')).toBe(0);
  });

  it('PAYOUT_HOLD_DAYS con decimales se redondea hacia abajo', () => {
    expect(parseHoldDays('2.9')).toBe(2);
    expect(parseHoldDays(6.5)).toBe(6);
  });

  it('PAYOUT_HOLD_DAYS null o infinito → 7', () => {
    expect(parseHoldDays(null)).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
    expect(parseHoldDays(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
  });

  it('el 0 del local manda aunque PAYOUT_HOLD_DAYS sea ilegible', () => {
    expect(resolveHoldDays(0, 'nunca')).toBe(0);
  });

  it('venueHoldDays: lee solo los días del local por su id y los usa', async () => {
    const db = { venue: { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: 0 }) } };
    expect(await venueHoldDays(db as never, '7', TENANT)).toBe(0);
    expect(db.venue.findUnique).toHaveBeenCalledWith({ where: { id: TENANT }, select: { payoutHoldDays: true } });
  });

  it('venueHoldDays: local sin regla o que no aparece → PAYOUT_HOLD_DAYS (o 7 si no vale)', async () => {
    const sinRegla = { venue: { findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: null }) } };
    expect(await venueHoldDays(sinRegla as never, '3', TENANT)).toBe(3);
    const noEsta = { venue: { findUnique: vi.fn().mockResolvedValue(null) } };
    expect(await venueHoldDays(noEsta as never, 'abc', TENANT)).toBe(DEFAULT_PAYOUT_HOLD_DAYS);
  });
});

describe('payoutRoutingChanges — casos límite de la cuenta de cobro', () => {
  it('sin método ni dirección en el cambio: no toca nada (aunque lo guardado esté mal)', () => {
    expect(payoutRoutingChanges({ payoutMethod: 'USDT_TRC20', payoutAddress: 'vieja-mal' }, {})).toEqual({});
  });

  it('quitar solo la dirección (null) deja el método', () => {
    expect(payoutRoutingChanges({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN }, { payoutAddress: null })).toEqual({
      payoutAddress: null,
    });
  });

  it('quitar método y dirección a la vez', () => {
    expect(
      payoutRoutingChanges({ payoutMethod: 'USDT_TRC20', payoutAddress: TRON }, { payoutMethod: null, payoutAddress: null }),
    ).toEqual({ payoutMethod: null, payoutAddress: null });
  });

  it('solo la dirección: se valida y normaliza con el método guardado', () => {
    expect(
      payoutRoutingChanges({ payoutMethod: 'SEPA_IBAN', payoutAddress: null }, { payoutAddress: ' es91 2100 0418 4502 0005 1332 ' }),
    ).toEqual({ payoutAddress: IBAN });
    expect(() =>
      payoutRoutingChanges({ payoutMethod: 'SEPA_IBAN', payoutAddress: null }, { payoutAddress: 'ES00 1234' }),
    ).toThrow(BadRequestException);
  });

  it('solo el método, sin dirección guardada: vale (la dirección se pone luego)', () => {
    expect(payoutRoutingChanges({ payoutMethod: null, payoutAddress: null }, { payoutMethod: 'USDT_TRC20' })).toEqual({
      payoutMethod: 'USDT_TRC20',
    });
  });

  it('cambiar al método que cuadra con la dirección guardada: vale', () => {
    expect(payoutRoutingChanges({ payoutMethod: 'MANUAL_CASH', payoutAddress: TRON }, { payoutMethod: 'USDT_TRC20' })).toEqual({
      payoutMethod: 'USDT_TRC20',
    });
  });
});
