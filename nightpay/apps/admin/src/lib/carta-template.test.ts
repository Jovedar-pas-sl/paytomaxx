import { describe, expect, it } from 'vitest';
import { CreateServiceItemSchema, DEFAULT_SECTIONS, sectionsOf } from '@nightpay/contracts';
import {
  CARTA_TEMPLATE,
  cartaTemplatePlan,
  templateButtonLabel,
  templateDiffText,
  templateSkipText,
  templateUpdates,
} from './carta-template';
import type { ServiceItem } from './endpoints/carta';

const stored = (): ServiceItem[] => CARTA_TEMPLATE.map((p, n) => ({ ...p, id: String(n), active: true, sortOrder: p.sortOrder, isInvitation: p.isInvitation ?? false }));
const sections = sectionsOf(null);

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
  it('un precio o una desactivación del dueño se enseñan como cambio a marcar, con el motivo', () => {
    const items = stored();
    items[0] = { ...items[0]!, name: ' COPA ', priceCents: 900, active: false };
    const plan = cartaTemplatePlan(items);
    expect(plan[0]).toMatchObject({ action: 'update', existing: { id: '0' }, input: { priceCents: 1000 } });
    expect(plan[0]!.diffs.map(templateDiffText).map((t) => t.replace(/\s/g, ' '))).toEqual([
      'Precio: 9,00 € → 10,00 € (tu precio es distinto del de referencia)',
      'Reactivar: ahora está desactivado y el personal no lo ve',
    ]);
    expect(plan.slice(1).every((p) => p.action === 'keep')).toBe(true);
  });
  it('sin marcar no se envía ningún cambio; marcado, con lo que se vio', () => {
    const items = stored();
    items[0] = { ...items[0]!, priceCents: 900 };
    const plan = cartaTemplatePlan(items);
    expect(templateUpdates(plan, new Set())).toEqual([]);
    expect(templateUpdates(plan, new Set(['0', '1']))).toEqual([{ id: '0', seen: { priceCents: 900, durationMin: null, sortOrder: 0, active: true } }]);
  });
  it('no elige entre duplicados ni convierte packs o invitaciones: los omite sin bloquear el resto', () => {
    const items = stored();
    const dup = cartaTemplatePlan([...items, { ...items[0]!, id: 'dup' }]);
    expect(dup[0]).toMatchObject({ action: 'skip', reason: 'duplicate' });
    expect(dup.slice(1).every((p) => p.action === 'keep')).toBe(true);
    expect(cartaTemplatePlan([{ ...items[0]!, isInvitation: true }])[0]).toMatchObject({ action: 'skip', reason: 'is-invitation' });
    expect(cartaTemplatePlan([{ ...items[0]!, components: [{ category: 'VENUE_BAR', amountCents: 1000 }] }])[0]).toMatchObject({ action: 'skip', reason: 'pack' });
    expect(cartaTemplatePlan([{ ...items[0]!, components: { invalid: true } as never }])[0]).toMatchObject({ action: 'skip', reason: 'pack' });
    expect(templateSkipText(dup[0]!, sections)).toBe('Tienes 2 productos «Copa»: no se toca ninguno.');
  });
  it('omite las secciones apagadas con su nombre, y el resto se aplica', () => {
    const off = sections.map((s) => (s.code === 'VENUE_FOOD' ? { ...s, enabled: false } : s));
    const plan = cartaTemplatePlan([], { sections: off });
    const skipped = plan.filter((p) => p.action === 'skip');
    expect(skipped.map((p) => p.input.name)).toEqual(['Tabla ibérica', 'Ración del día']);
    expect(templateSkipText(skipped[0]!, off)).toBe(`La sección «${DEFAULT_SECTIONS.VENUE_FOOD.label}» está apagada (Ajustes → Secciones): se omite.`);
    expect(plan.filter((p) => p.action === 'create')).toHaveLength(11);
  });
  it('una invitación con otro nombre cuenta: no se crea una segunda', () => {
    const own: ServiceItem = { id: 'inv', name: 'Invita a Nerea', category: 'VENUE_BAR', priceCents: 2500, durationMin: null, sortOrder: 9, active: false, isInvitation: true };
    const row = cartaTemplatePlan([own]).at(-1)!;
    expect(row).toMatchObject({ action: 'skip', reason: 'invitation-exists', others: [own] });
    expect(templateSkipText(row, sections)).toBe('Ya tienes la invitación «Invita a Nerea»: no se crea otra.');
    const fake = cartaTemplatePlan([{ ...own, name: 'Invitar a una copa', isInvitation: false }]).at(-1)!;
    expect(fake).toMatchObject({ action: 'skip', reason: 'not-invitation' });
  });
  it('normaliza nombres Unicode NFC antes de comparar sin crear otra ración', () => {
    const items = stored();
    items[5] = { ...items[5]!, name: '  RACIÓN DEL DÍA  ' };
    expect(cartaTemplatePlan(items)[5]).toMatchObject({ action: 'keep', existing: { id: '5' } });
  });
  it('el botón dice lo que va a pasar', () => {
    expect(templateButtonLabel(0, 0)).toBe('Nada que aplicar');
    expect(templateButtonLabel(12, 0)).toBe('Añadir 12 productos');
    expect(templateButtonLabel(1, 0)).toBe('Añadir 1 producto');
    expect(templateButtonLabel(0, 2)).toBe('Actualizar 2 productos');
    expect(templateButtonLabel(10, 1)).toBe('Añadir 10 productos y actualizar 1');
  });
});

it('añade la invitación de 20 € a una carta anterior sin duplicar los doce productos', () => {
  const existing = stored().slice(0, 12);
  const pending = cartaTemplatePlan(existing).filter((p) => p.action !== 'keep');
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ action: 'create', input: { name: 'Invitar a una copa', priceCents: 2000, isInvitation: true } });
});
