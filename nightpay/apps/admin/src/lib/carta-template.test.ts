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

/** La carta de referencia de antes (hasta el 2026-10-28), tal como la tienen los locales que la aplicaron. */
const OLD_TEMPLATE: ServiceItem[] = [
  ['Copa', 'VENUE_BAR', 1000, null],
  ['Copa premium', 'VENUE_BAR', 1400, null],
  ['Botella', 'VENUE_BAR', 12000, null],
  ['Chupito', 'VENUE_BAR', 500, null],
  ['Tabla ibérica', 'VENUE_FOOD', 3000, null],
  ['Ración del día', 'VENUE_FOOD', 1200, null],
  ['Entrada', 'VENUE_ENTRY', 1500, null],
  ['Entrada VIP', 'VENUE_ENTRY', 3000, null],
  ['30 min', 'CHICA_SERVICE', 8000, 30],
  ['45 min', 'CHICA_SERVICE', 10000, 45],
  ['1 h', 'CHICA_SERVICE', 12000, 60],
  ['2 h', 'CHICA_SERVICE', 22000, 120],
  ['Invitar a una copa', 'VENUE_BAR', 2000, null],
].map(([name, category, priceCents, durationMin], n) => ({
  id: `old-${n}`,
  name: name as string,
  category: category as ServiceItem['category'],
  priceCents: priceCents as number,
  durationMin: durationMin as number | null,
  sortOrder: n,
  active: true,
  isInvitation: name === 'Invitar a una copa',
}));

describe('carta aprobada', () => {
  it('acepta todos los productos y conserva los precios de ambas pantallas', () => {
    for (const p of CARTA_TEMPLATE) expect(CreateServiceItemSchema.safeParse(p).success).toBe(true);
    expect(CARTA_TEMPLATE.map((p) => p.priceCents)).toEqual([1000, 2000, 12000, 500, 3000, 1200, 1500, 3000, 8000, 10000, 12000, 22000]);
    expect(cartaTemplatePlan([]).every((p) => p.action === 'create')).toBe(true);
  });
  it('«Copa» es la copa normal y justo detrás va «Copa con invitación» (20 €, la invitación de la chica); sin «Copa premium»', () => {
    expect(CARTA_TEMPLATE.slice(0, 2)).toEqual([
      { name: 'Copa', category: 'VENUE_BAR', priceCents: 1000, durationMin: null, sortOrder: 0 },
      { name: 'Copa con invitación', category: 'VENUE_BAR', priceCents: 2000, durationMin: null, isInvitation: true, sortOrder: 1 },
    ]);
    expect(CARTA_TEMPLATE.filter((p) => p.isInvitation)).toHaveLength(1);
    expect(CARTA_TEMPLATE.map((p) => p.name)).not.toContain('Copa premium');
    expect(CARTA_TEMPLATE.map((p) => p.name)).not.toContain('Invitar a una copa');
  });
  it('un local con la carta de referencia de antes no recibe nada nuevo: su «Invitar a una copa» ya es la invitación', () => {
    const plan = cartaTemplatePlan(OLD_TEMPLATE);
    expect(plan.filter((p) => p.action === 'create' || p.action === 'update')).toEqual([]);
    const invitation = plan.find((p) => p.input.isInvitation)!;
    expect(invitation).toMatchObject({ action: 'skip', reason: 'invitation-exists', others: [{ name: 'Invitar a una copa' }] });
    expect(templateSkipText(invitation, sections)).toBe('Ya tienes la invitación «Invitar a una copa»: no se crea otra.');
  });
  it('y tras la migración (la invitación renombrada y segunda; «Copa premium» apagada) queda igual que la referencia', () => {
    const migrated = OLD_TEMPLATE.map((p) =>
      p.name === 'Invitar a una copa'
        ? { ...p, name: 'Copa con invitación', sortOrder: 1 }
        : p.name === 'Copa premium'
          ? { ...p, active: false }
          : p,
    );
    expect(cartaTemplatePlan(migrated).every((p) => p.action === 'keep')).toBe(true);
  });
  it('reaplicar no duplica ni modifica una carta ya configurada', () => {
    expect(cartaTemplatePlan(stored()).every((p) => p.action === 'keep')).toBe(true);
    const partial = stored().slice(0, 4);
    expect(cartaTemplatePlan(partial).filter((p) => p.action === 'create')).toHaveLength(8);
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
    expect(plan.filter((p) => p.action === 'create')).toHaveLength(10);
  });
  it('una invitación con otro nombre cuenta: no se crea una segunda', () => {
    const own: ServiceItem = { id: 'inv', name: 'Invita a Nerea', category: 'VENUE_BAR', priceCents: 2500, durationMin: null, sortOrder: 9, active: false, isInvitation: true };
    const row = cartaTemplatePlan([own]).find((p) => p.input.isInvitation)!;
    expect(row).toMatchObject({ action: 'skip', reason: 'invitation-exists', others: [own] });
    expect(templateSkipText(row, sections)).toBe('Ya tienes la invitación «Invita a Nerea»: no se crea otra.');
    const fake = cartaTemplatePlan([{ ...own, name: 'Copa con invitación', isInvitation: false }]).find((p) => p.input.isInvitation)!;
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

it('añade la copa con invitación de 20 € a una carta anterior sin duplicar los doce productos', () => {
  // Las doce de antes de las invitaciones (con «Copa premium», que la referencia ya no trae ni toca).
  const existing = OLD_TEMPLATE.slice(0, 12);
  const pending = cartaTemplatePlan(existing).filter((p) => p.action !== 'keep');
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ action: 'create', input: { name: 'Copa con invitación', priceCents: 2000, isInvitation: true, sortOrder: 1 } });
});
