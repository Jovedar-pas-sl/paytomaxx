import { describe, it, expect } from 'vitest';
import { lastNightCutoff, madridAt, madridDay, madridStartOfDay, nextDay, nextNightCutoff } from './madrid';

describe('fechas en hora de Madrid', () => {
  it('día de Madrid: a las 23:30 UTC de verano ya es el día siguiente', () => {
    expect(madridDay(new Date('2026-07-10T23:30:00Z'))).toBe('2026-07-11');
    expect(madridDay(new Date('2026-07-10T21:30:00Z'))).toBe('2026-07-10');
  });

  it('inicio del día en verano (UTC+2) y en invierno (UTC+1)', () => {
    expect(madridStartOfDay('2026-07-10').toISOString()).toBe('2026-07-09T22:00:00.000Z');
    expect(madridStartOfDay('2026-01-10').toISOString()).toBe('2026-01-09T23:00:00.000Z');
  });

  it('días de cambio de hora', () => {
    // 29-mar-2026: a las 02:00 pasa a las 03:00 → el día empieza aún en UTC+1.
    expect(madridStartOfDay('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // 25-oct-2026: a las 03:00 vuelve a las 02:00 → el día empieza en UTC+2.
    expect(madridStartOfDay('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(madridStartOfDay('2026-10-26').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('día siguiente, también a fin de mes y de año', () => {
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('corte de la noche (08:00 de Madrid)', () => {
  it('08:00 de Madrid en verano e invierno', () => {
    expect(madridAt('2026-07-10', 8).toISOString()).toBe('2026-07-10T06:00:00.000Z');
    expect(madridAt('2026-01-10', 8).toISOString()).toBe('2026-01-10T07:00:00.000Z');
    // Día del cambio de hora de octubre: a las 08:00 ya es invierno.
    expect(madridAt('2026-10-25', 8).toISOString()).toBe('2026-10-25T07:00:00.000Z');
  });

  it('la noche en curso empieza en las últimas 08:00', () => {
    // 03:00 de Madrid del 14-oct → empezó a las 08:00 del 13-oct.
    expect(lastNightCutoff(new Date('2026-10-14T01:00:00Z')).toISOString()).toBe('2026-10-13T06:00:00.000Z');
    // 10:00 de Madrid del 14-oct → empezó a las 08:00 del 14-oct.
    expect(lastNightCutoff(new Date('2026-10-14T08:00:00Z')).toISOString()).toBe('2026-10-14T06:00:00.000Z');
  });

  it('una noche abierta a las 22:00 se cierra sola a las 08:00 del día siguiente', () => {
    expect(nextNightCutoff(new Date('2026-10-13T20:00:00Z')).toISOString()).toBe('2026-10-14T06:00:00.000Z');
    // Abierta a las 03:00 → las 08:00 del mismo día.
    expect(nextNightCutoff(new Date('2026-10-14T01:00:00Z')).toISOString()).toBe('2026-10-14T06:00:00.000Z');
  });
});
