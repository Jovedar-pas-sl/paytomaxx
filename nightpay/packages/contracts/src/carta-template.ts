import { z } from 'zod';
import type { CreateServiceItemDto } from './services';

export type CartaTemplateInput = CreateServiceItemDto & { durationMin: number | null; sortOrder: number };

/** Productos y precios aprobados. Las propinas se configuran por separado. */
const ROWS: readonly Omit<CartaTemplateInput, 'sortOrder'>[] = [
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
  { name: 'Invitar a una copa', category: 'VENUE_BAR', priceCents: 2000, durationMin: null, isInvitation: true },
];
export const CARTA_TEMPLATE: readonly CartaTemplateInput[] = ROWS.map((item, sortOrder) => ({ ...item, sortOrder }));

/** Structural input keeps the planner usable by the API's raw JSON and the apps. */
interface TemplateItem {
  name: string;
  category: string;
  priceCents: number;
  durationMin: number | null;
  sortOrder: number;
  active: boolean;
  isInvitation?: boolean;
  components?: unknown;
}
export interface TemplateChange<T extends TemplateItem = TemplateItem> {
  input: CartaTemplateInput;
  existing?: T;
  action: 'create' | 'update' | 'keep' | 'conflict';
}
const nameKey = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase('es');

/** Never pick one duplicate or convert a pack/invitation to a different product. */
export function cartaTemplatePlan<T extends TemplateItem>(items: readonly T[]): TemplateChange<T>[] {
  return CARTA_TEMPLATE.map((input) => {
    const matches = items.filter((item) => item.category === input.category && nameKey(item.name) === nameKey(input.name));
    if (matches.length === 0) return { input, action: 'create' };
    const existing = matches[0]!;
    const hasPack = existing.components !== null && existing.components !== undefined &&
      (!Array.isArray(existing.components) || existing.components.length > 0);
    if (matches.length > 1 || Boolean(existing.isInvitation) !== Boolean(input.isInvitation) || hasPack) {
      return { input, existing, action: 'conflict' };
    }
    const same = existing.priceCents === input.priceCents && existing.durationMin === input.durationMin &&
      existing.sortOrder === input.sortOrder && existing.active;
    return { input, existing, action: same ? 'keep' : 'update' };
  });
}

export const ApplyCartaTemplateSchema = z.object({ confirm: z.literal(true) }).strict();
export type ApplyCartaTemplateDto = z.infer<typeof ApplyCartaTemplateSchema>;
export interface ApplyCartaTemplateResult { created: number; updated: number; kept: number }
