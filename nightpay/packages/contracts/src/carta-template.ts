import { z } from 'zod';
import { UuidSchema } from './common';
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

/** Structural input keeps the planner usable by the API's raw rows and the apps. */
interface TemplateItem {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  durationMin: number | null;
  sortOrder: number;
  active: boolean;
  isInvitation?: boolean;
  components?: unknown;
}

/** Lo que la referencia cambiaría de un producto que ya existe. */
export type CartaTemplateField = 'priceCents' | 'durationMin' | 'sortOrder' | 'active';
export interface CartaTemplateDiff {
  field: CartaTemplateField;
  from: number | boolean | null;
  to: number | boolean | null;
}

/** Por qué una fila de la referencia no se aplica. */
export type CartaTemplateSkip =
  /** Su sección está apagada en el local. */
  | 'section-off'
  /** Hay varios productos con ese nombre en la sección: no se elige uno. */
  | 'duplicate'
  /** El del local con ese nombre es un pack. */
  | 'pack'
  /** El del local con ese nombre es una invitación. */
  | 'is-invitation'
  /** Hay un producto con el nombre de la invitación que no es invitación. */
  | 'not-invitation'
  /** El local ya tiene una invitación con otro nombre: no se crea otra. */
  | 'invitation-exists';

/**
 * Una fila de la referencia frente a la carta del local:
 *  - create: no existe; se añade (lo único que se aplica sin marcar nada).
 *  - keep: existe y es igual.
 *  - update: existe y es distinto; solo se cambia si el dueño lo marca.
 *  - skip: no se toca (`reason`); `others`, los productos que lo explican.
 */
export interface TemplateChange<T extends TemplateItem = TemplateItem> {
  input: CartaTemplateInput;
  existing?: T;
  action: 'create' | 'update' | 'keep' | 'skip';
  diffs: CartaTemplateDiff[];
  reason?: CartaTemplateSkip;
  others?: T[];
}

const nameKey = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase('es');
const hasPack = (components: unknown) =>
  components !== null && components !== undefined && (!Array.isArray(components) || components.length > 0);

/** Lo que la referencia pondría en un producto que ya existe (nunca el nombre, la sección ni si es invitación). */
export function cartaTemplateDiffs(existing: TemplateItem, input: CartaTemplateInput): CartaTemplateDiff[] {
  const diffs: CartaTemplateDiff[] = [];
  if (existing.priceCents !== input.priceCents) diffs.push({ field: 'priceCents', from: existing.priceCents, to: input.priceCents });
  if (existing.durationMin !== input.durationMin) diffs.push({ field: 'durationMin', from: existing.durationMin, to: input.durationMin });
  if (existing.sortOrder !== input.sortOrder) diffs.push({ field: 'sortOrder', from: existing.sortOrder, to: input.sortOrder });
  if (!existing.active) diffs.push({ field: 'active', from: false, to: true });
  return diffs;
}

function matchOf<T extends TemplateItem>(items: readonly T[], input: CartaTemplateInput): Omit<TemplateChange<T>, 'input'> {
  const named = items.filter((item) => item.category === input.category && nameKey(item.name) === nameKey(input.name));
  if (named.length > 1) return { action: 'skip', reason: 'duplicate', diffs: [], others: named };
  const existing = named[0];
  if (input.isInvitation) {
    if (existing && !existing.isInvitation) return { existing, action: 'skip', reason: 'not-invitation', diffs: [] };
    if (!existing) {
      // Una invitación por local: la que tenga otro nombre también cuenta.
      const invitations = items.filter((item) => Boolean(item.isInvitation));
      return invitations.length > 0
        ? { action: 'skip', reason: 'invitation-exists', diffs: [], others: invitations }
        : { action: 'create', diffs: [] };
    }
  } else if (existing?.isInvitation) {
    return { existing, action: 'skip', reason: 'is-invitation', diffs: [] };
  }
  if (!existing) return { action: 'create', diffs: [] };
  if (hasPack(existing.components)) return { existing, action: 'skip', reason: 'pack', diffs: [] };
  const diffs = cartaTemplateDiffs(existing, input);
  return { existing, action: diffs.length === 0 ? 'keep' : 'update', diffs };
}

/**
 * La referencia frente a la carta del local. Por defecto solo se añade lo que
 * falta; un producto existente se cambia solo si se marca (nunca se pisa un
 * precio del dueño). Una sección apagada se omite, sin bloquear el resto.
 */
export function cartaTemplatePlan<T extends TemplateItem>(
  items: readonly T[],
  opts: { sections?: ReadonlyArray<{ code: string; enabled: boolean }> } = {},
): TemplateChange<T>[] {
  const off = new Set((opts.sections ?? []).filter((s) => !s.enabled).map((s) => s.code));
  return CARTA_TEMPLATE.map((input) => {
    const match = matchOf(items, input);
    if ((match.action === 'create' || match.action === 'update') && off.has(input.category)) {
      return { input, ...match, action: 'skip', reason: 'section-off', diffs: [] };
    }
    return { input, ...match };
  });
}

/** Lo que el dueño vio de un producto al marcarlo: si cambió desde entonces, no se toca. */
export const CartaTemplateSeenSchema = z
  .object({
    priceCents: z.number().int(),
    durationMin: z.number().int().nullable(),
    sortOrder: z.number().int(),
    active: z.boolean(),
  })
  .strict();
export type CartaTemplateSeen = z.infer<typeof CartaTemplateSeenSchema>;

export const ApplyCartaTemplateSchema = z
  .object({
    confirm: z.literal(true),
    /** Los productos existentes que el dueño marcó para ponerlos como la referencia. */
    update: z
      .array(z.object({ id: UuidSchema, seen: CartaTemplateSeenSchema }).strict())
      .max(CARTA_TEMPLATE.length)
      .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, { message: 'Un producto marcado dos veces' })
      .optional(),
  })
  .strict();
export type ApplyCartaTemplateDto = z.infer<typeof ApplyCartaTemplateSchema>;
export interface ApplyCartaTemplateResult {
  created: number;
  updated: number;
  /** Ya existían y se dejaron como estaban (iguales o sin marcar). */
  kept: number;
  /** Omitidas: sección apagada, duplicados, packs o invitación ya existente. */
  skipped: number;
}

/** Lo visto de un producto (lo que se envía al marcarlo). */
export function cartaTemplateSeen(item: Pick<TemplateItem, 'priceCents' | 'durationMin' | 'sortOrder' | 'active'>): CartaTemplateSeen {
  return { priceCents: item.priceCents, durationMin: item.durationMin, sortOrder: item.sortOrder, active: item.active };
}

/** ¿Sigue el producto como lo vio el dueño? */
export function sameAsSeen(item: Pick<TemplateItem, 'priceCents' | 'durationMin' | 'sortOrder' | 'active'>, seen: CartaTemplateSeen): boolean {
  return item.priceCents === seen.priceCents && item.durationMin === seen.durationMin &&
    item.sortOrder === seen.sortOrder && item.active === seen.active;
}
