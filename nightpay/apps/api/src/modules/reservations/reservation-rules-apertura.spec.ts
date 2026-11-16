import { describe, expect, it } from 'vitest';
import { openMinuteOf, openTimeText } from '@nightpay/contracts';
import {
  arrivalProblem,
  autoNoShowAt,
  bookableNightProblem,
  clientCancelProblem,
  clientChangeBlocker,
  commissionDue,
  nightStart,
} from './reservation-rules';

// Respuestas del dueño (17-nov): las 48 h desde la hora de apertura, esta misma
// noche hasta 2 h antes de abrir, el cliente anula con 48 h, «No vino» solo a
// las 12:00 del día siguiente y el RRPP pierde la comisión si cambia el local.

describe('la hora de apertura', () => {
  it('«22:30» ↔ 1350; horas raras no', () => {
    expect(openMinuteOf('22:30')).toBe(1350);
    expect(openMinuteOf('0:15')).toBe(15);
    expect(openMinuteOf('24:00')).toBeNull();
    expect(openTimeText(1350)).toBe('22:30');
    expect(openTimeText(15)).toBe('00:15');
  });

  it('la noche empieza a su hora de apertura; de madrugada, ya es el día siguiente', () => {
    // 21-nov, invierno (UTC+1).
    expect(nightStart('2026-11-21', 1350).toISOString()).toBe('2026-11-21T21:30:00.000Z');
    expect(nightStart('2026-11-21', 60).toISOString()).toBe('2026-11-22T00:00:00.000Z');
    expect(nightStart('2026-11-21').toISOString()).toBe('2026-11-21T19:00:00.000Z');
  });

  it('para esta misma noche se reserva hasta 2 h antes de abrir; después ya no', () => {
    const open = 23 * 60; // abre a las 23:00 (22:00 UTC)
    expect(bookableNightProblem('2026-11-21', new Date('2026-11-21T19:59:00Z'), open)).toBeNull();
    expect(bookableNightProblem('2026-11-21', new Date('2026-11-21T20:01:00Z'), open)).toBe('Para esta noche se reserva hasta 2 horas antes de abrir');
    // Otra noche, sin problema a esa hora.
    expect(bookableNightProblem('2026-11-22', new Date('2026-11-21T20:01:00Z'), open)).toBeNull();
  });

  it('las 48 h del cambio de fecha cuentan desde la apertura', () => {
    const r = { status: 'PAID', nightDate: '2026-11-25', dateChangedAt: null };
    const open = 23 * 60;
    const limit = new Date(nightStart('2026-11-25', open).getTime() - 48 * 3600_000);
    expect(clientChangeBlocker(r, limit, open)).toBeNull();
    expect(clientChangeBlocker(r, new Date(limit.getTime() + 60_000), open)).toBe('La fecha se cambia avisando con 48 horas');
    // Con la hora de antes (20:00) ya no podría: la apertura cuenta.
    expect(clientChangeBlocker(r, new Date(limit.getTime() - 60_000), 20 * 60)).toBe('La fecha se cambia avisando con 48 horas');
  });
});

describe('el cliente anula', () => {
  const night = '2026-11-25';
  const limit = new Date(nightStart(night).getTime() - 48 * 3600_000);

  it('sin pagar, siempre; pagada, solo con 48 h; si no, «No vino»', () => {
    expect(clientCancelProblem({ status: 'PENDING', nightDate: night }, new Date(limit.getTime() + 86_400_000))).toBeNull();
    expect(clientCancelProblem({ status: 'DEPOSIT_PAID', nightDate: night }, limit)).toBeNull();
    expect(clientCancelProblem({ status: 'PAID', nightDate: night }, new Date(limit.getTime() + 60_000))).toBe(
      'Se anula avisando con 48 horas. Si no venís, se queda como «No vino».',
    );
    expect(clientCancelProblem({ status: 'ARRIVED', nightDate: night }, limit)).toBe('Esta reserva ya no se puede anular');
  });
});

describe('«No vino» a las 12:00 y la llegada tarde', () => {
  it('a las 12:00 de Madrid del día siguiente', () => {
    expect(autoNoShowAt('2026-11-21').toISOString()).toBe('2026-11-22T11:00:00.000Z');
    expect(autoNoShowAt('2027-07-10').toISOString()).toBe('2027-07-11T10:00:00.000Z');
  });

  it('el encargado apunta tarde la llegada de una noche pasada; el resto, solo en su noche', () => {
    const r = { status: 'PAID', paidCents: 30000, priceCents: 30000, nightDate: '2026-11-21' };
    const nextDay = new Date('2026-11-22T12:00:00Z');
    expect(arrivalProblem(r, nextDay)).toBe('Esta reserva es de la noche del 2026-11-21');
    expect(arrivalProblem(r, nextDay, true)).toBeNull();
    expect(arrivalProblem({ ...r, nightDate: '2026-11-23' }, nextDay, true)).toBe('Esta reserva es de la noche del 2026-11-23');
  });
});

describe('el RRPP pierde la comisión si el local cambia la fecha o anula', () => {
  it('con la comisión quitada, aunque se pague entero, no la gana', () => {
    const base = { priceCents: 30000, paidCents: 30000, promoterId: 'p1', commissionEarnedAt: null };
    expect(commissionDue(base)).toBe(true);
    expect(commissionDue({ ...base, commissionVoidedAt: new Date() })).toBe(false);
  });
});
