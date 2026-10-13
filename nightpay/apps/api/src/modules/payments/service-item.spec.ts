import { describe, it, expect } from 'vitest';
import { applyServiceItem } from './service-item';

const ITEM = {
  id: 'item-1',
  name: '30 min',
  priceCents: 10000,
  durationMin: 30,
  category: 'CHICA_SERVICE',
  active: true,
};

describe('applyServiceItem — cobrar desde la carta', () => {
  it('el precio, la categoría y el nombre salen de la carta', () => {
    expect(applyServiceItem(ITEM, 'OPERATOR')).toEqual({
      ok: true,
      amountCents: 10000,
      revenueCategory: 'CHICA_SERVICE',
      serviceName: '30 min',
      durationMin: 30,
    });
  });

  it('un servicio desactivado no se puede cobrar', () => {
    expect(applyServiceItem({ ...ITEM, active: false }, 'OPERATOR')).toEqual({ ok: false, reason: 'inactive' });
  });

  it('la chica no puede cobrar un artículo de barra de la carta', () => {
    expect(applyServiceItem({ ...ITEM, category: 'VENUE_BAR' }, 'OPERATOR')).toEqual({
      ok: false,
      reason: 'role-not-allowed',
    });
  });

  it('el camarero cobra artículos del local con su categoría', () => {
    const r = applyServiceItem({ ...ITEM, name: 'Copa', category: 'VENUE_BAR', durationMin: null }, 'WAITER');
    expect(r).toMatchObject({ ok: true, revenueCategory: 'VENUE_BAR', serviceName: 'Copa', durationMin: null });
  });

  it('una categoría desconocida en la carta no se acepta', () => {
    expect(applyServiceItem({ ...ITEM, category: 'INVENTADA' }, 'OWNER')).toEqual({
      ok: false,
      reason: 'invalid-category',
    });
  });
});
