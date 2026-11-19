import { describe, expect, it } from 'vitest';
import { appendPage, historyParams, httpsUrl, madridInstant, nightRange, NO_DAYS, rangeProblem } from './history';

// El historial con fechas de la app (Cobros, Ganancias y Pagos recibidos):
// las fechas que elige ella son noches de Madrid (de 08:00 a 08:00), se
// mire desde donde se mire.

describe('madridInstant', () => {
  it('las 08:00 de Madrid en invierno (UTC+1) y en verano (UTC+2)', () => {
    expect(madridInstant('2026-11-19', 8).toISOString()).toBe('2026-11-19T07:00:00.000Z');
    expect(madridInstant('2026-07-04', 8).toISOString()).toBe('2026-07-04T06:00:00.000Z');
  });

  it('el día del cambio de hora (29-mar y 25-oct de 2026)', () => {
    expect(madridInstant('2026-03-29', 8).toISOString()).toBe('2026-03-29T06:00:00.000Z');
    expect(madridInstant('2026-10-25', 8).toISOString()).toBe('2026-10-25T07:00:00.000Z');
  });
});

describe('nightRange', () => {
  it('sin fechas: nada', () => {
    expect(nightRange(NO_DAYS)).toEqual({});
  });

  it('desde la noche del primer día hasta el final de la noche del último (las 08:00 del día siguiente)', () => {
    expect(nightRange({ fromDay: '2026-11-01', toDay: '2026-11-15' })).toEqual({
      from: '2026-11-01T07:00:00.000Z',
      to: '2026-11-16T07:00:00.000Z',
    });
    expect(nightRange({ fromDay: '2026-11-30', toDay: '2026-12-31' })).toEqual({
      from: '2026-11-30T07:00:00.000Z',
      to: '2027-01-01T07:00:00.000Z',
    });
  });

  it('solo una de las dos, o algo que no es un día: la otra abierta', () => {
    expect(nightRange({ fromDay: '2026-11-10', toDay: '' })).toEqual({ from: '2026-11-10T07:00:00.000Z' });
    expect(nightRange({ fromDay: '10/11/2026', toDay: '2026-11-10' })).toEqual({ to: '2026-11-11T07:00:00.000Z' });
  });
});

describe('rangeProblem', () => {
  it('«Desde» después de «Hasta»: se dice; si no, nada', () => {
    expect(rangeProblem({ fromDay: '2026-11-15', toDay: '2026-11-01' })).toMatch(/antes/);
    expect(rangeProblem({ fromDay: '2026-11-01', toDay: '2026-11-01' })).toBeNull();
    expect(rangeProblem(NO_DAYS)).toBeNull();
  });
});

describe('historyParams', () => {
  it('cuántas, las fechas y la página siguiente', () => {
    expect(historyParams(NO_DAYS).toString()).toBe('limit=50');
    const q = historyParams({ fromDay: '2026-11-01', toDay: '2026-11-15' }, 'abc');
    expect(Object.fromEntries(q)).toEqual({ limit: '50', from: '2026-11-01T07:00:00.000Z', to: '2026-11-16T07:00:00.000Z', cursor: 'abc' });
  });
});

describe('appendPage', () => {
  it('añade la página siguiente sin repetir una fila que ya estaba', () => {
    expect(appendPage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
});

describe('httpsUrl', () => {
  it('solo un enlace https', () => {
    expect(httpsUrl('https://banco.example/j/4')).toBe('https://banco.example/j/4');
    expect(httpsUrl('  https://banco.example/j/4  ')).toBe('https://banco.example/j/4');
    for (const bad of ['http://banco.example/j/4', 'javascript:alert(1)', 'data:text/html,hola', 'ftp://x', 'no es un enlace', '', null, undefined]) {
      expect(httpsUrl(bad), String(bad)).toBeNull();
    }
  });
});
