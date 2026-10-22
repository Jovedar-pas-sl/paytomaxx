// La carta de referencia en el panel (lógica pura): qué pasará con cada
// producto y por qué, dicho para el dueño. El plan es el mismo que aplica el API.

import { cartaTemplateSeen, type CartaTemplateDiff, type TemplateChange, type VenueSection } from '@nightpay/contracts';
import type { ServiceItem } from './endpoints/carta';
import { formatEur } from './money';
import { sectionLabelOf } from './money-map';

export { CARTA_TEMPLATE, cartaTemplatePlan, type TemplateChange } from '@nightpay/contracts';

/** «Precio: 9,00 € → 10,00 €», con el motivo. */
export function templateDiffText(diff: CartaTemplateDiff): string {
  switch (diff.field) {
    case 'priceCents':
      return `Precio: ${formatEur(Number(diff.from))} → ${formatEur(Number(diff.to))} (tu precio es distinto del de referencia)`;
    case 'durationMin':
      return `Duración: ${diff.from === null ? 'sin duración' : `${diff.from} min`} → ${diff.to === null ? 'sin duración' : `${diff.to} min`}`;
    case 'sortOrder':
      return `Orden en la carta: ${diff.from} → ${diff.to}`;
    case 'active':
      return 'Reactivar: ahora está desactivado y el personal no lo ve';
  }
}

/** Por qué no se toca una fila. */
export function templateSkipText(change: TemplateChange<ServiceItem>, sections: readonly VenueSection[]): string {
  const name = change.existing?.name.trim() ?? change.input.name;
  const others = (change.others ?? []).map((o) => `«${o.name.trim()}»`).join(', ');
  switch (change.reason) {
    case 'section-off':
      return `La sección «${sectionLabelOf(sections, change.input.category)}» está apagada (Ajustes → Secciones): se omite.`;
    case 'duplicate':
      return `Tienes ${change.others?.length ?? 2} productos «${change.input.name}»: no se toca ninguno.`;
    case 'pack':
      return `Tu «${name}» es un pack: no se toca.`;
    case 'is-invitation':
      return `Tu «${name}» es una invitación: no se toca.`;
    case 'not-invitation':
      return `Ya tienes «${name}» y no es una invitación: no se crea otro. Si lo es, márcalo como invitación abajo.`;
    case 'invitation-exists':
      return `Ya tienes la invitación ${others}: no se crea otra.`;
    default:
      return 'Se omite.';
  }
}

/** Lo que se envía al aplicar: los productos marcados, con lo que se vio de cada uno. */
export function templateUpdates(plan: readonly TemplateChange<ServiceItem>[], ticked: ReadonlySet<string>) {
  return plan
    .filter((c) => c.action === 'update' && c.existing && ticked.has(c.existing.id))
    .map((c) => ({ id: c.existing!.id, seen: cartaTemplateSeen(c.existing!) }));
}

/** «Añadir 12 y actualizar 1 productos» → «Añadir 12 productos y actualizar 1». */
export function templateButtonLabel(creates: number, updates: number): string {
  if (creates === 0 && updates === 0) return 'Nada que aplicar';
  const n = (count: number) => `${count} ${count === 1 ? 'producto' : 'productos'}`;
  if (updates === 0) return `Añadir ${n(creates)}`;
  if (creates === 0) return `Actualizar ${n(updates)}`;
  return `Añadir ${n(creates)} y actualizar ${updates}`;
}
