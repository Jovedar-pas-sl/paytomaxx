import { describe, expect, it } from 'vitest';
import { peakIndex, sparkGeometry, SPARK_WIDTH } from './sparkline';

// El minigráfico de «Pagado esta noche» (idea 9 B): una línea por horas en una
// caja de 100 de ancho y `height` de alto, con margen para el punto de la última hora.

const pairs = (points: string) => points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);

describe('el minigráfico', () => {
  it('todos los puntos caen dentro de la caja: de 0 a 100 de ancho y con margen arriba y abajo', () => {
    const g = sparkGeometry([0, 100, 50, 25], 32)!;
    const pts = pairs(g.points);
    expect(pts).toHaveLength(4);
    expect(pts[0]![0]).toBe(0);
    expect(pts.at(-1)![0]).toBe(SPARK_WIDTH);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(SPARK_WIDTH);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(29);
    }
    // Lo más alto arriba; el 0, abajo.
    expect(pts[1]![1]).toBe(3);
    expect(pts[0]![1]).toBe(29);
    expect(g.last).toEqual({ x: SPARK_WIDTH, y: pts.at(-1)![1] });
  });

  it('todo a cero: una línea plana, abajo', () => {
    const g = sparkGeometry([0, 0, 0], 32)!;
    expect(new Set(pairs(g.points).map(([, y]) => y))).toEqual(new Set([29]));
  });

  it('con negativos (una recarga anulada) la línea baja del 0', () => {
    const g = sparkGeometry([100, -100, 0], 32)!;
    const [a, b, c] = pairs(g.points);
    expect(g.zeroY).toBe(16);
    expect(a![1]).toBe(3);
    expect(b![1]).toBe(29);
    expect(b![1]).toBeGreaterThan(g.zeroY);
    expect(c![1]).toBe(g.zeroY);
  });

  it('con menos de dos horas no hay gráfico', () => {
    expect(sparkGeometry([], 32)).toBeNull();
    expect(sparkGeometry([500], 32)).toBeNull();
  });

  it('el pico: la hora con más (la primera si empatan); sin nada pagado, ninguno', () => {
    expect(peakIndex([10, 30, 30, 5])).toBe(1);
    expect(peakIndex([0, 0])).toBeNull();
    expect(peakIndex([-5, 0])).toBeNull();
    expect(peakIndex([])).toBeNull();
  });
});
