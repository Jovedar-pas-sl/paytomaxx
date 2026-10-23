import { describe, expect, it } from 'vitest';
import { zNetLabel, zTypeLabel } from './z-labels';

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

describe('el neto del Z sin el personal', () => {
  it('un Z de ahora (trae la parte de los camareros, aunque sea 0): «Neto sin el personal»', () => {
    expect(zNetLabel({ camareroNetCents: 0 })).toBe('Neto sin el personal');
    expect(zNetLabel({ camareroNetCents: 600 })).toBe('Neto sin el personal');
  });

  it('un Z congelado antes (sin la parte de los camareros): solo restaba lo de las chicas', () => {
    expect(zNetLabel({})).toBe('Neto sin las chicas');
  });
});
