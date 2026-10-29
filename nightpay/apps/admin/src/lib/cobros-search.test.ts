import { describe, expect, it } from 'vitest';
import { nextSearch, SEARCH_MIN_CHARS } from './cobros-search';

describe('buscador de código o referencia del banco', () => {
  it('pide al menos 3 caracteres, como el API (el código de confirmación tiene 3)', () => {
    expect(SEARCH_MIN_CHARS).toBe(3);
    expect(nextSearch(' A6B ')).toBe('A6B');
    expect(nextSearch('BBVA123')).toBe('BBVA123');
  });

  it('con 1 o 2 caracteres no se busca: se queda la búsqueda que había', () => {
    expect(nextSearch('1')).toBe('');
    expect(nextSearch('12', 'A6B')).toBe('A6B');
  });

  it('vacío quita la búsqueda', () => {
    expect(nextSearch('  ', 'A6B')).toBe('');
  });
});
