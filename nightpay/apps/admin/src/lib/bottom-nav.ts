// Barra de abajo del panel en el móvil (y las pestañas de arriba en el
// escritorio): las cinco secciones, sin «Más». Sale de visibleSections
// (lib/roles), así que cada rol ve solo lo que puede usar.

import type { PanelSection, SectionKey } from './roles';

export interface BottomNavItem {
  key: SectionKey;
  label: string;
}

export function bottomNavItems(sections: readonly PanelSection[]): BottomNavItem[] {
  return sections.map((s) => ({ key: s.key, label: s.label }));
}

const BADGE_MAX = 99;

/** Tipos de incidencia que en la bandeja del dueño ya salen como tarjeta de «Por aprobar». */
const APPROVAL_INCIDENT_KINDS: ReadonlySet<string> = new Set(['approval_pending']);
const NONE: ReadonlySet<string> = new Set();

/**
 * Lo que hay en Avisos, un solo número: incidencias abiertas y, al dueño, lo
 * que puede aprobar (sin contar dos veces la incidencia de una solicitud que
 * ya está en la lista). null = aún no se sabe nada.
 */
export function avisosCount(input: {
  incidents: ReadonlyArray<{ kind: string }> | null;
  approvals: number | null;
  isOwner: boolean;
}): number | null {
  const pending = input.isOwner ? input.approvals : null;
  if (input.incidents === null && pending === null) return null;
  const hidden = inboxHiddenKinds(input.isOwner);
  const incidents = (input.incidents ?? []).filter((i) => !hidden.has(i.kind));
  return incidents.length + (pending ?? 0);
}

/** Incidencias que no salen en Avisos: al dueño, las que ya son tarjeta de «Por aprobar». */
export function inboxHiddenKinds(isOwner: boolean): ReadonlySet<string> {
  return isOwner ? APPROVAL_INCIDENT_KINDS : NONE;
}

/** Globo de una sección y lo que lee el lector de pantalla (null = sin globo). Solo «Hoy» lleva. */
export function navBadge(key: SectionKey, avisos: number | null): { text: string; spoken: string } | null {
  if (key !== 'hoy' || avisos === null) return null;
  const text = badgeText(avisos);
  return text ? { text, spoken: `${avisos} ${avisos === 1 ? 'aviso' : 'avisos'}` } : null;
}

/** Número del globo: nada con 0; "99+" desde 100. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(Math.floor(count));
}
