import { describe, it, expect } from 'vitest';
import { madridQuarter, madridRecentDaysWindow, madridTodayWindow } from './reporting-window';

const iso = (d: Date): string => d.toISOString();

describe('trimestre del IVA en hora de Madrid', () => {
  it('Q1-2026: del 1-ene (UTC+1) al 1-abr, que ya es horario de verano (UTC+2)', () => {
    const q = madridQuarter('Q1-2026');
    expect(q.label).toBe('Q1-2026');
    expect(iso(q.from)).toBe('2025-12-31T23:00:00.000Z');
    expect(iso(q.to)).toBe('2026-03-31T22:00:00.000Z');
  });

  it('el trimestre son sus tres meses seguidos, sin huecos ni solapes', () => {
    const q = madridQuarter('Q1-2026');
    expect(q.months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(q.months.map((m) => [iso(m.from), iso(m.to)])).toEqual([
      ['2025-12-31T23:00:00.000Z', '2026-01-31T23:00:00.000Z'],
      ['2026-01-31T23:00:00.000Z', '2026-02-28T23:00:00.000Z'],
      // Marzo acaba ya en verano: la medianoche del 1-abr son las 22:00 UTC.
      ['2026-02-28T23:00:00.000Z', '2026-03-31T22:00:00.000Z'],
    ]);
    expect(q.months[0]!.from).toEqual(q.from);
    expect(q.months[2]!.to).toEqual(q.to);
  });

  it('Q4 cruza el cambio de hora de octubre y el año', () => {
    const q = madridQuarter('Q4-2026');
    expect(iso(q.from)).toBe('2026-09-30T22:00:00.000Z');
    expect(iso(q.months[0]!.to)).toBe('2026-10-31T23:00:00.000Z');
    expect(iso(q.to)).toBe('2026-12-31T23:00:00.000Z');
    expect(madridQuarter('Q4-2025').months.map((m) => m.month)).toEqual(['2025-10', '2025-11', '2025-12']);
  });

  it('sin trimestre: el de hoy en Madrid (el 1-jul a las 00:30 de Madrid ya es Q3)', () => {
    expect(madridQuarter(undefined, new Date('2026-06-30T22:30:00Z')).label).toBe('Q3-2026');
    expect(madridQuarter(undefined, new Date('2026-06-30T21:30:00Z')).label).toBe('Q2-2026');
    expect(madridQuarter(undefined, new Date('2025-12-31T23:30:00Z')).label).toBe('Q1-2026');
  });

  it('formato inválido → Error', () => {
    expect(() => madridQuarter('Q5-2026')).toThrow();
    expect(() => madridQuarter('Q1-26')).toThrow();
    expect(() => madridQuarter('2026-Q1')).toThrow();
  });
});

describe('días de las métricas en hora de Madrid', () => {
  it('hoy: desde las 00:00 de Madrid (a las 01:30 de Madrid ya es el día siguiente)', () => {
    const now = new Date('2026-10-14T23:30:00Z');
    expect(madridTodayWindow(now)).toEqual({ from: new Date('2026-10-14T22:00:00Z'), to: now });
  });

  it('hoy en el día del cambio de hora de marzo (el día empieza aún en UTC+1)', () => {
    const now = new Date('2026-03-29T12:00:00Z');
    expect(iso(madridTodayWindow(now).from)).toBe('2026-03-28T23:00:00.000Z');
  });

  it('últimos días: 00:00 de Madrid de hace 7 días aunque en medio cambie la hora', () => {
    // 27-oct (invierno) → desde el 20-oct a las 00:00 de Madrid (aún verano).
    const now = new Date('2026-10-27T10:00:00Z');
    expect(madridRecentDaysWindow(now, 7)).toEqual({ from: new Date('2026-10-19T22:00:00Z'), to: now });
  });
});
