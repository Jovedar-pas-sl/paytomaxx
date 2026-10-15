import { describe, expect, it } from 'vitest';
import {
  dayInZone,
  formatDateTime,
  isValidRange,
  lastDayOfMonth,
  madridToday,
  presetRange,
} from './dates';

describe('formatDateTime', () => {
  const iso = '2026-10-15T19:30:05Z'; // 21:30 en Madrid (CEST)

  it('usa la zona del local, no la del navegador', () => {
    expect(formatDateTime(iso, 'Europe/Madrid', 'time')).toBe('21:30');
    expect(formatDateTime(iso, 'America/Mexico_City', 'time')).toBe('13:30');
  });

  it('formatos del panel', () => {
    expect(formatDateTime(iso, 'Europe/Madrid', 'datetime')).toBe('15/10/2026, 21:30');
    expect(formatDateTime(iso, 'Europe/Madrid', 'short')).toBe('15 oct, 21:30');
    expect(formatDateTime(iso, 'Europe/Madrid', 'compact')).toBe('15/10, 21:30');
    expect(formatDateTime(iso, 'Europe/Madrid', 'weekday')).toBe('jue, 15/10');
    expect(formatDateTime(iso, 'Europe/Madrid', 'date')).toBe('15/10/2026');
  });

  it('una zona desconocida cae en Madrid y una fecha ilegible sale como raya', () => {
    expect(formatDateTime(iso, 'Marte/Base', 'time')).toBe('21:30');
    expect(formatDateTime('no-es-fecha')).toBe('—');
  });
});

describe('días de Madrid', () => {
  it('a las 00:30 de Madrid ya es el día siguiente aunque en UTC no', () => {
    const now = new Date('2026-10-15T22:30:00Z');
    expect(madridToday(now)).toBe('2026-10-16');
    expect(dayInZone(now, 'UTC')).toBe('2026-10-15');
  });
});

describe('presetRange', () => {
  const now = new Date('2026-01-01T00:30:00+01:00'); // 1 de enero en Madrid, 31 dic en UTC

  it('mes pasado y este mes según el día de Madrid', () => {
    expect(presetRange('lastMonth', now)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('thisMonth', now)).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });

  it('trimestre pasado cruza de año', () => {
    expect(presetRange('lastQuarter', now)).toEqual({ from: '2025-10-01', to: '2025-12-31' });
  });

  it('este año', () => {
    expect(presetRange('thisYear', new Date('2026-05-20T10:00:00Z'))).toEqual({
      from: '2026-01-01',
      to: '2026-05-20',
    });
  });
});

describe('utilidades de periodo', () => {
  it('último día del mes, bisiestos incluidos', () => {
    expect(lastDayOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-02-01')).toBe('2026-02-28');
  });

  it('la fecha final no puede ser anterior a la inicial', () => {
    expect(isValidRange('2026-10-01', '2026-10-31')).toBe(true);
    expect(isValidRange('2026-10-01', '2026-10-01')).toBe(true);
    expect(isValidRange('2026-10-02', '2026-10-01')).toBe(false);
    expect(isValidRange('', '2026-10-01')).toBe(false);
  });
});
