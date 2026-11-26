import { describe, expect, it } from 'vitest';
import { FALLBACK_SECTIONS } from './money-map';
import { COBROS_VIEWS, activeFilterCount, activeView, applyView, filterChips, hourText, parseColumns, withoutFilters } from './cobros-views';

// Las vistas y las fichas de los filtros de Cobros (idea 17). Puro, sin pantalla.

const ctx = {
  tz: 'Europe/Madrid',
  nights: [{ id: 'n1', openedAt: '2026-11-14T21:04:00Z' }],
  operators: [{ id: 'o1', name: 'Marta' }],
  sections: FALLBACK_SECTIONS,
};
const labels = (f: Parameters<typeof filterChips>[0]) => filterChips(f, ctx).map((c) => c.label);

describe('vistas de Cobros', () => {
  it('las cuatro, con su nombre y en su orden', () => {
    expect(COBROS_VIEWS.map((v) => v.label)).toEqual(['Todos', 'Con problema', 'Devueltos', 'Con saldo']);
  });

  it('una vista está marcada solo si `status` y `method` son exactamente los suyos', () => {
    expect(activeView({})).toBe('todos');
    expect(activeView({ nightId: 'n1', search: 'C-0024' })).toBe('todos');
    expect(activeView({ status: ['ORPHAN', 'AUTHORIZING', 'FAILED'] })).toBe('problema');
    expect(activeView({ status: ['FAILED', 'ORPHAN', 'AUTHORIZING'] })).toBe('problema');
    expect(activeView({ status: ['ORPHAN', 'FAILED'] })).toBeNull();
    expect(activeView({ status: ['ORPHAN', 'AUTHORIZING', 'FAILED'], method: 'CARD' })).toBeNull();
    expect(activeView({ status: ['REFUNDED', 'PARTIALLY_REFUNDED'] })).toBe('devueltos');
    expect(activeView({ method: 'SALDO' })).toBe('saldo');
    expect(activeView({ method: 'SALDO', status: ['AUTHORIZED'] })).toBeNull();
    expect(activeView({ method: 'CARD' })).toBeNull();
  });

  it('elegir una vista cambia solo el estado y la forma de pago', () => {
    const before = { nightId: 'n1', operatorId: 'o1', method: 'CARD' as const, status: ['AUTHORIZED'] };
    expect(applyView(before, 'saldo')).toEqual({ nightId: 'n1', operatorId: 'o1', method: 'SALDO' });
    expect(applyView(before, 'devueltos')).toEqual({ nightId: 'n1', operatorId: 'o1', status: ['REFUNDED', 'PARTIALLY_REFUNDED'] });
    expect(applyView(before, 'todos')).toEqual({ nightId: 'n1', operatorId: 'o1' });
  });
});

describe('fichas de los filtros', () => {
  it('cada filtro, con su texto', () => {
    expect(labels({ status: ['REFUNDED'] })).toEqual(['Estado: Devuelto']);
    expect(labels({ status: ['ORPHAN', 'AUTHORIZING', 'FAILED'] })).toEqual(['Estado: Sin confirmar y 2 más']);
    expect(labels({ nightId: 'n1' })).toEqual(['Noche: sáb 14']);
    expect(labels({ operatorId: 'o1' })).toEqual(['Compañera: Marta']);
    expect(labels({ category: FALLBACK_SECTIONS[0]!.code })).toEqual([`Sección: ${FALLBACK_SECTIONS[0]!.label}`]);
    expect(labels({ method: 'CARD' })).toEqual(['Forma de pago: Tarjeta']);
    expect(labels({ walletCode: 'K7Q' })).toEqual(['Código del saldo: K7Q']);
    expect(labels({ search: 'C-0024' })).toEqual(['Buscar: C-0024']);
    expect(labels({ from: '2026-11-14T21:00:00Z' })).toEqual(['Fechas del mapa: 14 nov, 22:00 → ahora']);
    expect(labels({ to: '2026-11-14T21:00:00Z' })).toEqual(['Fechas del mapa: el principio → 14 nov, 22:00']);
    expect(labels({})).toEqual([]);
  });

  it('una noche o una compañera que no está en la lista no rompe la ficha', () => {
    expect(labels({ nightId: 'otra' })).toEqual(['Noche: elegida']);
    expect(labels({ operatorId: 'otra' })).toEqual(['Compañera: elegida']);
  });

  it('la ✕ de una ficha quita solo lo suyo (las fechas, las dos a la vez)', () => {
    const f = { status: ['REFUNDED'], nightId: 'n1', from: '2026-11-14T21:00:00Z', to: '2026-11-15T05:00:00Z' };
    const chips = filterChips(f, ctx);
    expect(withoutFilters(f, chips.find((c) => c.key === 'fechas')!.clears)).toEqual({ status: ['REFUNDED'], nightId: 'n1' });
    expect(withoutFilters(f, chips.find((c) => c.key === 'status')!.clears)).toEqual({ nightId: 'n1', from: f.from, to: f.to });
  });

  it('«Filtros (N)» cuenta lo elegido, sin el buscador (que está a la vista)', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ search: 'C-0024' })).toBe(0);
    expect(activeFilterCount({ status: ['ORPHAN', 'FAILED'], nightId: 'n1', search: 'C-0024', from: 'a', to: 'b' })).toBe(3);
  });
});

describe('la hora de una fila', () => {
  const now = Date.parse('2026-11-15T02:00:00Z');
  it('solo la hora; pasadas 18 horas, con el día', () => {
    expect(hourText('2026-11-15T01:14:00Z', 'Europe/Madrid', now)).toBe('02:14');
    expect(hourText('2026-11-14T08:01:00Z', 'Europe/Madrid', now)).toBe('09:01');
    expect(hourText('2026-11-14T01:14:00Z', 'Europe/Madrid', now)).toBe('14 nov, 02:14');
  });
});

describe('las columnas de más (np-cobros-cols)', () => {
  it('solo las que existen, sin repetir y en su orden; lo que no se entiende, ninguna', () => {
    expect(parseColumns('["banco","ref"]')).toEqual(['ref', 'banco']);
    expect(parseColumns('["ref","ref","otra",3]')).toEqual(['ref']);
    expect(parseColumns('{"ref":true}')).toEqual([]);
    expect(parseColumns('no es json')).toEqual([]);
    expect(parseColumns(null)).toEqual([]);
  });
});
