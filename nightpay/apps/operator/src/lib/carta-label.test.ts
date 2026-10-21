import { expect, it } from 'vitest';
import { addItem, cuentaSummary, cuentaWhat, itemLabel } from './cuenta';

it('conserva las duraciones visibles de la maqueta sin repetirlas', () => {
  for (const [name, durationMin] of [['30 min', 30], ['45 min', 45], ['1 h', 60], ['2 h', 120]] as const) {
    expect(itemLabel({ name, durationMin })).toBe(name);
  }
  expect(itemLabel({ name: 'Servicio', durationMin: 60 })).toBe('Servicio · 1 h');
  expect(itemLabel({ name: 'Servicio', durationMin: 45 })).toBe('Servicio · 45 min');
  expect(itemLabel({ name: 'Copa', durationMin: null })).toBe('Copa');
});
it('mantiene la duración en la cuenta y el resumen del cobro', () => {
  const cuenta = addItem([], { id: 's', name: 'Servicio', durationMin: 60, priceCents: 12000, category: 'CHICA_SERVICE' });
  expect(cuentaSummary(cuenta, () => 'Servicios')).toBe('Servicio · 1 h · Servicios');
  expect(cuentaWhat(cuenta)).toBe('Servicio · 1 h');
});
