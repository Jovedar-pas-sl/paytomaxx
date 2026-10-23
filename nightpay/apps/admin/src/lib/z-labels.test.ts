import { describe, expect, it } from 'vitest';
import { zTypeLabel } from './z-labels';

describe('nombres de las líneas del Z', () => {
  it('un Z congelado antes de dejar de decir «wallet» se enseña con el nombre de ahora', () => {
    expect(zTypeLabel('Recarga de wallet')).toBe('Recarga con tarjeta');
  });

  it('lo demás, tal cual (secciones, recargas en efectivo, nombres del local)', () => {
    for (const label of ['Recarga con tarjeta', 'Recarga en efectivo', 'Copas', 'Reservados VIP', 'Servicio de chica + Habitación']) {
      expect(zTypeLabel(label)).toBe(label);
    }
  });
});
