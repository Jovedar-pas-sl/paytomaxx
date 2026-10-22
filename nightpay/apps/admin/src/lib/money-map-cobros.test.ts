import { describe, expect, it } from 'vitest';
import type { MoneyMap } from '@nightpay/contracts';
import { canOpenSection, moneyMapCobrosFilter } from './money-map-cobros';
import { cobrosQuery } from './endpoints/money-map';

const live = { from: '2026-10-21T19:00:00.000Z', to: '2026-10-22T01:40:00.000Z', frozen: false, scope: { kind: 'night', nightId: 'n1', open: true } } as MoneyMap;
const z = { ...live, frozen: true, scope: { kind: 'night', nightId: 'n1', open: false } } as MoneyMap;

describe('del mapa del dinero a los cobros', () => {
  it('una sección abre sus cobros con las fechas del mapa (en directo, abiertas por arriba)', () => {
    expect(moneyMapCobrosFilter(live, { kind: 'section', code: 'VENUE_BAR' })).toEqual({ from: live.from, category: 'VENUE_BAR' });
    expect(moneyMapCobrosFilter(z, { kind: 'section', code: 'VENUE_BAR' })).toEqual({ from: z.from, to: z.to, category: 'VENUE_BAR' });
  });
  it('«Del saldo» filtra los cobros del saldo; las ventas, todos los del periodo', () => {
    expect(moneyMapCobrosFilter(z, { kind: 'saldo' })).toEqual({ from: z.from, to: z.to, method: 'SALDO' });
    expect(moneyMapCobrosFilter({ ...z, scope: { kind: 'period' } } as MoneyMap, { kind: 'sales' })).toEqual({ from: z.from, to: z.to });
  });
  it('las propinas no son una sección de la lista; el resto, sí', () => {
    expect(canOpenSection('TIPS')).toBe(false);
    expect(canOpenSection('EXTRA')).toBe(true);
    expect(canOpenSection('CHICA_SERVICE')).toBe(true);
  });
  it('las fechas van al API tal cual', () => {
    const qs = new URLSearchParams(cobrosQuery(moneyMapCobrosFilter(z, { kind: 'section', code: 'VENUE_FOOD' }), { limit: 50 }));
    expect(Object.fromEntries(qs)).toEqual({ from: z.from, to: z.to, category: 'VENUE_FOOD', limit: '50' });
  });
});
