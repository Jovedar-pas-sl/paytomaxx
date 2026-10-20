// Carta del panel (lógica pura): servicios agrupados por sección y las partes de un pack.

import { parseEuroCents, packProblem, type PackComponent, type SectionCode, type VenueSection } from '@nightpay/contracts';
import type { ServiceItem } from './endpoints/carta';

export interface CartaGroup {
  code: string;
  label: string;
  color: string | null;
  enabled: boolean;
  items: ServiceItem[];
}

/** La carta por secciones, en el orden de las secciones del local; los antiguos («Otros») al final. */
export function groupBySection(items: readonly ServiceItem[], sections: readonly VenueSection[]): CartaGroup[] {
  const groups: CartaGroup[] = sections.map((s) => ({ code: s.code, label: s.label, color: s.color, enabled: s.enabled, items: [] }));
  const other: CartaGroup = { code: 'EXTRA', label: 'Otros (antiguos)', color: null, enabled: true, items: [] };
  for (const item of items) (groups.find((g) => g.code === item.category) ?? other).items.push(item);
  return [...groups, other].filter((g) => g.items.length > 0);
}

/** Una parte del pack tal como se teclea (importe en texto). */
export interface PartDraft {
  category: SectionCode;
  amount: string;
}

/** Las partes tecleadas → partes del pack, o el problema (en español). */
export function packFromDraft(
  priceCents: number,
  category: SectionCode,
  parts: readonly PartDraft[],
): { ok: true; components: PackComponent[] } | { ok: false; problem: string } {
  const components: PackComponent[] = [];
  for (const p of parts) {
    const cents = parseEuroCents(p.amount);
    if (cents === null) return { ok: false, problem: 'Pon el importe de cada parte del pack.' };
    components.push({ category: p.category, amountCents: cents });
  }
  if (new Set(components.map((c) => c.category)).size !== components.length) {
    return { ok: false, problem: 'Cada parte del pack va a una sección distinta.' };
  }
  const problem = packProblem(priceCents, category, components);
  return problem ? { ok: false, problem } : { ok: true, components };
}

/** Lo que falta (o sobra) para que las partes sumen el precio, en céntimos (0 = cuadra). */
export function packRemainder(priceCents: number, parts: readonly PartDraft[]): number {
  const sum = parts.reduce((acc, p) => acc + (parseEuroCents(p.amount) ?? 0), 0);
  return priceCents - sum;
}
