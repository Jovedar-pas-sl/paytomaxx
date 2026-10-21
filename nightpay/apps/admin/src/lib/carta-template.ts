import type { ServiceItem, ServiceItemInput } from './endpoints/carta';

/** Productos y precios aprobados en la referencia de losetas. Propinas: Ajustes → Formas de cobro. */
const TEMPLATE_ROWS: readonly ServiceItemInput[] = [
  { name: 'Copa', category: 'VENUE_BAR', priceCents: 1000, durationMin: null },
  { name: 'Copa premium', category: 'VENUE_BAR', priceCents: 1400, durationMin: null },
  { name: 'Botella', category: 'VENUE_BAR', priceCents: 12000, durationMin: null },
  { name: 'Chupito', category: 'VENUE_BAR', priceCents: 500, durationMin: null },
  { name: 'Tabla ibérica', category: 'VENUE_FOOD', priceCents: 3000, durationMin: null },
  { name: 'Ración del día', category: 'VENUE_FOOD', priceCents: 1200, durationMin: null },
  { name: 'Entrada', category: 'VENUE_ENTRY', priceCents: 1500, durationMin: null },
  { name: 'Entrada VIP', category: 'VENUE_ENTRY', priceCents: 3000, durationMin: null },
  { name: '30 min', category: 'CHICA_SERVICE', priceCents: 8000, durationMin: 30 },
  { name: '45 min', category: 'CHICA_SERVICE', priceCents: 10000, durationMin: 45 },
  { name: '1 h', category: 'CHICA_SERVICE', priceCents: 12000, durationMin: 60 },
  { name: '2 h', category: 'CHICA_SERVICE', priceCents: 22000, durationMin: 120 },
];
export const CARTA_TEMPLATE: readonly ServiceItemInput[] = TEMPLATE_ROWS.map((item, sortOrder) => ({ ...item, sortOrder }));

export interface TemplateChange {
  input: ServiceItemInput;
  existing?: ServiceItem;
  action: 'create' | 'update' | 'keep' | 'conflict';
}
const key = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase('es');

/** Repetible: actualiza coincidencias únicas; nunca convierte invitaciones/packs ni elige entre duplicados. */
export function cartaTemplatePlan(items: readonly ServiceItem[]): TemplateChange[] {
  return CARTA_TEMPLATE.map((input) => {
    const matches = items.filter((i) => i.category === input.category && key(i.name) === key(input.name));
    if (matches.length === 0) return { input, action: 'create' };
    const existing = matches[0]!;
    if (matches.length > 1 || existing.isInvitation || existing.components?.length) {
      return { input, existing, action: 'conflict' };
    }
    const same = existing.priceCents === input.priceCents && existing.durationMin === input.durationMin &&
      existing.sortOrder === input.sortOrder && existing.active;
    return { input, existing, action: same ? 'keep' : 'update' };
  });
}
