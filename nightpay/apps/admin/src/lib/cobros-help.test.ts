import { describe, expect, it } from 'vitest';
import { COBRO_ACTION_LABELS, COBRO_ACTION_TITLES } from './cobros-help';

// Los botones de un cobro: su texto y su title corto. La pintada de los
// botones, en components/CobroRowActions.test.tsx. «Ver detalle» ya no existe
// (entrega 9): el detalle se abre tocando la fila.

describe('botones de cada cobro', () => {
  it('uno por botón, con su texto tal cual y en su orden', () => {
    expect(Object.values(COBRO_ACTION_LABELS)).toEqual([
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
