import { describe, expect, it } from 'vitest';
import { newArrivals } from './pending-pos';

describe('aviso de cobros con datáfono nuevos', () => {
  it('la primera carga no suena (ya estaban ahí)', () => {
    const r = newArrivals(null, ['a', 'b']);
    expect(r.hasNew).toBe(false);
    expect([...r.seen]).toEqual(['a', 'b']);
  });

  it('suena si aparece uno que no se había visto', () => {
    expect(newArrivals(new Set(['a']), ['a', 'b']).hasNew).toBe(true);
  });

  it('no suena si solo se fue alguno (lo confirmó otro camarero)', () => {
    const r = newArrivals(new Set(['a', 'b']), ['a']);
    expect(r.hasNew).toBe(false);
    expect([...r.seen]).toEqual(['a']);
  });

  it('no suena con la lista vacía tras una vacía', () => {
    expect(newArrivals(new Set(), []).hasNew).toBe(false);
    expect(newArrivals(new Set(), ['x']).hasNew).toBe(true);
  });
});
