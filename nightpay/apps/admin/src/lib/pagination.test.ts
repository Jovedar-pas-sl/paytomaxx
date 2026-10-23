import { describe, expect, it } from 'vitest';
import { appendPage, mergeLatestPage } from './pagination';
import { nextPollDelay } from './use-polling';

const row = (id: string, minute: number) => ({ id, createdAt: `2026-10-15T20:${String(minute).padStart(2, '0')}:00Z` });

describe('mergeLatestPage', () => {
  it('el refresco no tira las páginas cargadas con "Cargar más"', () => {
    const shown = [row('e', 50), row('d', 40), row('c', 30), row('b', 20), row('a', 10)];
    const fresh = [row('f', 55), row('e', 50), row('d', 40)];
    expect(mergeLatestPage(fresh, shown).map((r) => r.id)).toEqual(['f', 'e', 'd', 'c', 'b', 'a']);
  });

  it('lo que ya no pasa el filtro desaparece de la parte nueva', () => {
    const shown = [row('e', 50), row('d', 40), row('c', 30)];
    const fresh = [row('e', 50), row('c', 30)];
    expect(mergeLatestPage(fresh, shown).map((r) => r.id)).toEqual(['e', 'c']);
  });

  it('la primera página trae ya toda la lista: lo de antes que no viene se quita (aunque sea más antiguo)', () => {
    // Cobro único pagado con la ficha: el cobro con tarjeta (C-0001, 20:10) deja de venir;
    // su fila es la del saldo, creada justo después.
    const shown = [row('card', 10)];
    const fresh = [row('saldo', 11)];
    expect(mergeLatestPage(fresh, shown, true).map((r) => r.id)).toEqual(['saldo']);
    expect(mergeLatestPage(fresh, shown, false).map((r) => r.id)).toEqual(['saldo', 'card']);
  });

  it('sin resultados, lista vacía', () => {
    expect(mergeLatestPage([], [row('a', 1)])).toEqual([]);
  });
});

describe('appendPage', () => {
  it('no repite filas', () => {
    expect(appendPage([row('b', 2), row('a', 1)], [row('a', 1), row('z', 0)]).map((r) => r.id)).toEqual([
      'b',
      'a',
      'z',
    ]);
  });
});

describe('nextPollDelay', () => {
  it('tras un fallo dobla la espera hasta el máximo; tras un acierto vuelve a lo normal', () => {
    expect(nextPollDelay(5000, false, 5000, 60_000)).toBe(10_000);
    expect(nextPollDelay(40_000, false, 5000, 60_000)).toBe(60_000);
    expect(nextPollDelay(60_000, true, 5000, 60_000)).toBe(5000);
  });
});
