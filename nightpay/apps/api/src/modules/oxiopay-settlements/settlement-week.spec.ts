import { describe, expect, it } from 'vitest';
import {
  GENERATE_FROM_HOUR,
  dueWeek,
  isoWeekOf,
  lastCompletedWeek,
  nextWeekAfter,
  nightsOf,
  previousWeeks,
  settlementReference,
  weekContaining,
  weekStartingOn,
  weeksBetween,
} from './settlement-week';

const T = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe('semana de la liquidación: de lunes 08:00 a lunes 08:00 de Madrid', () => {
  it('una semana normal (CET): 168 h, del lunes 26-oct 08:00 (07:00 UTC) al lunes 2-nov', () => {
    const w = weekStartingOn('2026-10-26');
    expect(w.from.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-02T07:00:00.000Z');
    expect(w.to.getTime() - w.from.getTime()).toBe(168 * HOUR);
    expect(w).toMatchObject({ monday: '2026-10-26', isoYear: 2026, isoWeek: 44 });
  });

  it('una semana de verano (CEST): las 08:00 son las 06:00 UTC', () => {
    const w = weekStartingOn('2026-07-06');
    expect(w.from.toISOString()).toBe('2026-07-06T06:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-07-13T06:00:00.000Z');
  });

  it('cambio de hora de octubre (domingo 25-oct-2026, 03:00 → 02:00): la semana dura 169 h y la noche del sábado 25 h', () => {
    const w = weekStartingOn('2026-10-19');
    expect(w.from.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(w.to.getTime() - w.from.getTime()).toBe(169 * HOUR);
    const nights = nightsOf(w);
    expect(nights.map((n) => n.day)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    const saturday = nights[5]!;
    expect(saturday.to.getTime() - saturday.from.getTime()).toBe(25 * HOUR);
    // Las noches se tocan: sin huecos ni solapes, de principio a fin de la semana.
    expect(nights[0]!.from).toEqual(w.from);
    expect(nights[6]!.to).toEqual(w.to);
    for (let i = 1; i < 7; i += 1) expect(nights[i]!.from).toEqual(nights[i - 1]!.to);
  });

  it('cambio de hora de marzo (domingo 28-mar-2027, 02:00 → 03:00): 167 h y la noche del sábado 23 h', () => {
    const w = weekStartingOn('2027-03-22');
    expect(w.from.toISOString()).toBe('2027-03-22T07:00:00.000Z');
    expect(w.to.toISOString()).toBe('2027-03-29T06:00:00.000Z');
    expect(w.to.getTime() - w.from.getTime()).toBe(167 * HOUR);
    const saturday = nightsOf(w)[5]!;
    expect(saturday.to.getTime() - saturday.from.getTime()).toBe(23 * HOUR);
  });

  it('solo empieza en lunes', () => {
    expect(() => weekStartingOn('2026-10-27')).toThrow(/lunes/);
    expect(() => weekStartingOn('2026-13-01')).toThrow();
  });

  it('la semana de un instante: el lunes 07:59 es de la anterior y las 08:00 de la nueva (también con el cambio de hora)', () => {
    // Lunes 26-oct-2026 (ya en CET): 07:59 = 06:59 UTC.
    expect(weekContaining(T('2026-10-26T06:59:59Z')).monday).toBe('2026-10-19');
    expect(weekContaining(T('2026-10-26T07:00:00Z')).monday).toBe('2026-10-26');
    // Las 02:30 del domingo del cambio pasan dos veces (00:30 y 01:30 UTC): las dos, de la misma semana.
    expect(weekContaining(T('2026-10-25T00:30:00Z')).monday).toBe('2026-10-19');
    expect(weekContaining(T('2026-10-25T01:30:00Z')).monday).toBe('2026-10-19');
    // Un domingo por la tarde, de la semana que empezó el lunes anterior.
    expect(weekContaining(T('2026-11-01T18:00:00Z')).monday).toBe('2026-10-26');
  });

  it('última semana terminada y cuándo toca generarla (el lunes desde las 10:00, tras el corte y el resumen de las 9:00)', () => {
    expect(GENERATE_FROM_HOUR).toBe(10);
    // Lunes 2-nov 09:59 (08:59 UTC): la semana 44 ya terminó, pero aún no toca.
    expect(lastCompletedWeek(T('2026-11-02T08:59:00Z')).monday).toBe('2026-10-26');
    expect(dueWeek(T('2026-11-02T08:59:00Z'))).toBeNull();
    expect(dueWeek(T('2026-11-02T09:00:00Z'))?.monday).toBe('2026-10-26');
    // Martes o domingo: sigue tocando la misma (si no se generó, se genera).
    expect(dueWeek(T('2026-11-03T20:00:00Z'))?.monday).toBe('2026-10-26');
    expect(dueWeek(T('2026-11-08T22:00:00Z'))?.monday).toBe('2026-10-26');
    // Lunes 07:30: la semana en curso no ha terminado; la terminada es la anterior.
    expect(lastCompletedWeek(T('2026-11-09T06:30:00Z')).monday).toBe('2026-10-26');
    // Tras el cambio de hora de octubre: lunes 26-oct a las 10:00 CET (09:00 UTC).
    expect(dueWeek(T('2026-10-26T08:59:00Z'))).toBeNull();
    expect(dueWeek(T('2026-10-26T09:00:00Z'))?.monday).toBe('2026-10-19');
  });

  it('semanas anteriores, de la más reciente a la más antigua', () => {
    expect(previousWeeks(weekStartingOn('2026-11-02'), 3).map((w) => w.monday)).toEqual(['2026-10-26', '2026-10-19', '2026-10-12']);
  });
});

describe('semana ISO y referencia de la transferencia', () => {
  it('semana ISO del lunes (también la 53 y la 1 que empieza en diciembre)', () => {
    expect(isoWeekOf('2026-10-26')).toEqual({ isoYear: 2026, isoWeek: 44 });
    expect(isoWeekOf('2026-12-28')).toEqual({ isoYear: 2026, isoWeek: 53 });
    expect(isoWeekOf('2027-01-04')).toEqual({ isoYear: 2027, isoWeek: 1 });
    expect(isoWeekOf('2025-12-29')).toEqual({ isoYear: 2026, isoWeek: 1 });
    expect(isoWeekOf('2027-03-22')).toEqual({ isoYear: 2027, isoWeek: 12 });
  });

  it('OXP-2026-S44-<SLUG> (y /R2, /R3 al regenerarla, que no choca con ningún slug); SEPA: letras, cifras, guiones y /', () => {
    const w = weekStartingOn('2026-10-26');
    expect(settlementReference(w, 'luna-vlc')).toBe('OXP-2026-S44-LUNA-VLC');
    expect(settlementReference(w, 'luna-vlc', 2)).toBe('OXP-2026-S44-LUNA-VLC/R2');
    // El local «luna-2» y la regenerada de «luna» ya no se confunden.
    expect(settlementReference(w, 'luna-2')).not.toBe(settlementReference(w, 'luna', 2));
    expect(settlementReference(w, 'x'.repeat(300), 12)).toMatch(/\/R12$/);
    expect(settlementReference(weekStartingOn('2027-01-04'), 'Sala_ñ 1')).toBe('OXP-2027-S01-SALA-N-1');
    expect(settlementReference(w, 'x'.repeat(300)).length).toBeLessThanOrEqual(140);
  });
});

describe('semana de inicio y tramos de semanas', () => {
  it('la primera semana completa tras un instante: el lunes siguiente (aunque sea lunes 08:00 en punto)', () => {
    expect(nextWeekAfter(T('2026-10-28T12:00:00Z')).monday).toBe('2026-11-02');
    expect(nextWeekAfter(T('2026-11-02T07:00:00Z')).monday).toBe('2026-11-09');
    expect(nextWeekAfter(T('2026-11-02T06:59:00Z')).monday).toBe('2026-11-02');
  });

  it('las semanas desde una hasta un instante (sin incluirlo), en orden', () => {
    const start = weekStartingOn('2026-10-12');
    expect(weeksBetween(start, weekStartingOn('2026-11-02').from).map((w) => w.monday)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    expect(weeksBetween(start, start.from)).toEqual([]);
  });
});
