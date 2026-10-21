import { describe, expect, it } from 'vitest';
import { CreateServiceItemSchema } from '@nightpay/contracts';
import { CARTA_TEMPLATE, cartaTemplatePlan } from './carta-template';
import type { ServiceItem } from './endpoints/carta';

const stored = (): ServiceItem[] => CARTA_TEMPLATE.map((p, n) => ({ ...p, id: String(n), active: true, sortOrder: p.sortOrder!, isInvitation: p.isInvitation ?? false }));

describe('carta aprobada', () => {
  it('acepta todos los productos y conserva los precios de ambas pantallas', () => {
    for (const p of CARTA_TEMPLATE) expect(CreateServiceItemSchema.safeParse(p).success).toBe(true);
    expect(CARTA_TEMPLATE.map((p) => p.priceCents)).toEqual([1000, 1400, 12000, 500, 3000, 1200, 1500, 3000, 8000, 10000, 12000, 22000, 2000]);
    expect(cartaTemplatePlan([]).every((p) => p.action === 'create')).toBe(true);
  });
  it('reaplicar no duplica ni modifica una carta ya configurada', () => {
    expect(cartaTemplatePlan(stored()).every((p) => p.action === 'keep')).toBe(true);
    const partial = stored().slice(0, 4);
    expect(cartaTemplatePlan(partial).filter((p) => p.action === 'create')).toHaveLength(9);
    expect(cartaTemplatePlan(partial).filter((p) => p.action === 'keep')).toHaveLength(4);
  });
  it('detecta cambios de precio y reactivación sin cambiar otros productos', () => {
    const items = stored();
    items[0] = { ...items[0]!, name: ' COPA ', priceCents: 900, active: false };
    const plan = cartaTemplatePlan(items);
    expect(plan[0]).toMatchObject({ action: 'update', existing: { id: '0' }, input: { priceCents: 1000 } });
    expect(plan.slice(1).every((p) => p.action === 'keep')).toBe(true);
  });
  it('no selecciona duplicados ni convierte packs o invitaciones', () => {
    const items = stored();
    expect(cartaTemplatePlan([...items, { ...items[0]!, id: 'dup' }])[0]!.action).toBe('conflict');
    expect(cartaTemplatePlan([{ ...items[0]!, isInvitation: true }])[0]!.action).toBe('conflict');
    expect(cartaTemplatePlan([{ ...items[0]!, components: [{ category: 'VENUE_BAR', amountCents: 1000 }] }])[0]!.action).toBe('conflict');
  });
});


it('añade la invitación de 20 € a una carta anterior sin duplicar los doce productos', () => {
  const existing = stored().slice(0, 12);
  const pending = cartaTemplatePlan(existing).filter((p) => p.action !== 'keep');
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ action: 'create', input: { name: 'Invitar a una copa', priceCents: 2000, isInvitation: true } });
});
