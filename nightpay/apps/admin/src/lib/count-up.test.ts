import { describe, expect, it } from 'vitest';
import { COUNT_UP_MS, countUpValue, easeOutCubic } from './count-up';

describe('cifras que suben', () => {
  it('dura unos 500 ms', () => {
    expect(COUNT_UP_MS).toBe(500);
  });

  it('empieza en el valor de antes y acaba justo en el nuevo', () => {
    expect(countUpValue(119_400, 121_800, 0)).toBe(119_400);
    expect(countUpValue(119_400, 121_800, 1)).toBe(121_800);
    expect(countUpValue(119_400, 121_800, 2)).toBe(121_800);
  });

  it('sube de forma suave: más de la mitad del camino en la primera mitad del tiempo', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(countUpValue(0, 1000, 0.5)).toBe(875);
  });

  it('también baja (una devolución) y siempre da enteros', () => {
    expect(countUpValue(2_400, 0, 0.5)).toBe(300);
    expect(Number.isInteger(countUpValue(1, 2, 0.3))).toBe(true);
  });
});
