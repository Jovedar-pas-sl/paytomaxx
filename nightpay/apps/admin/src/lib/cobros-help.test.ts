import { describe, expect, it } from 'vitest';
import { COBRO_ACTION_LABELS, COBRO_ACTION_TITLES } from './cobros-help';

// Los botones de cada fila de Cobros: su texto y su title corto. La pintada
// de los botones, en components/CobroRowActions.test.tsx; el tutorial del «?»,
// que los nombra, en tours.test.ts.

describe('botones de cada cobro', () => {
  it('uno por botón, con su texto tal cual y en el orden de la fila', () => {
    expect(Object.values(COBRO_ACTION_LABELS)).toEqual([
      'Ver detalle',
      'Anular cobro',
      'Resolver',
      'Devolución BBVA',
      'Reembolsar',
      'Devoluciones',
    ]);
  });

  it('un title corto en cada botón (una línea al pasar el ratón)', () => {
    for (const [key, title] of Object.entries(COBRO_ACTION_TITLES)) {
      expect(title.length, key).toBeLessThanOrEqual(64);
      expect(title.length, key).toBeGreaterThan(10);
      expect(title, key).not.toMatch(/[!¡]/);
    }
    expect(Object.keys(COBRO_ACTION_TITLES).sort()).toEqual(Object.keys(COBRO_ACTION_LABELS).sort());
  });
});
