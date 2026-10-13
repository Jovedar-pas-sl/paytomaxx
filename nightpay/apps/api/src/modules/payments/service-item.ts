import { resolveRevenueCategory, type RevenueCategory } from './commission';

const CATEGORIES: ReadonlySet<string> = new Set<RevenueCategory>([
  'CHICA_SERVICE',
  'VENUE_BAR',
  'VENUE_ROOM',
  'VENUE_FOOD',
  'EXTRA',
]);

export interface ServiceItemLike {
  name: string;
  priceCents: number;
  durationMin: number | null;
  category: string;
  active: boolean;
}

export type ServiceCharge =
  | {
      ok: true;
      amountCents: number;
      revenueCategory: RevenueCategory;
      serviceName: string;
      durationMin: number | null;
    }
  | { ok: false; reason: 'inactive' | 'role-not-allowed' | 'invalid-category' };

/**
 * Cobro desde la carta (Fase 1A): el importe y la categoría los fija el local
 * en la carta, no quien cobra. Se aplican las mismas reglas por rol que a un
 * cobro libre (la chica solo cobra CHICA_SERVICE).
 */
export function applyServiceItem(
  item: ServiceItemLike,
  creatorRole: string | undefined | null,
): ServiceCharge {
  if (!item.active) return { ok: false, reason: 'inactive' };
  if (!CATEGORIES.has(item.category)) return { ok: false, reason: 'invalid-category' };
  const revenueCategory = resolveRevenueCategory({
    isWalletTopUp: false,
    creatorRole,
    requested: item.category as RevenueCategory,
  });
  if (!revenueCategory) return { ok: false, reason: 'role-not-allowed' };
  return {
    ok: true,
    amountCents: item.priceCents,
    revenueCategory,
    serviceName: item.name,
    durationMin: item.durationMin,
  };
}
