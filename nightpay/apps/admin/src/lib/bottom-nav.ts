// Barra de abajo del panel en el móvil: las cuatro secciones de la noche a
// mano y el resto en «Más». Sale de visibleTabs (lib/roles), así que el
// encargado tampoco ve aquí Banco ni Informes.

import type { PanelTab, TabKey } from './roles';

export interface BottomNavItem {
  key: TabKey;
  label: string;
}

/**
 * Abajo, en este orden y con nombres cortos. «Aprobar» solo lo ve el dueño (a
 * las 4 de la mañana, a un toque); el resto, dueño y encargado.
 */
const PRIMARY: readonly BottomNavItem[] = [
  { key: 'payments', label: 'Pagos' },
  { key: 'approvals', label: 'Aprobar' },
  { key: 'nights', label: 'Noche' },
  { key: 'incidents', label: 'Incidencias' },
  { key: 'operators', label: 'Chicas' },
];

export interface BottomNavModel {
  primary: BottomNavItem[];
  /** Lo demás que ese rol ve, en el orden de las pestañas. */
  more: PanelTab[];
}

export function bottomNavItems(tabs: readonly PanelTab[]): BottomNavModel {
  const visible = new Set(tabs.map((t) => t.key));
  const primary = PRIMARY.filter((p) => visible.has(p.key));
  const inPrimary = new Set(primary.map((p) => p.key));
  return { primary, more: tabs.filter((t) => !inPrimary.has(t.key)) };
}

/** La pestaña abierta está dentro de «Más» (se marca «Más»). */
export function isMoreActive(model: BottomNavModel, active: TabKey): boolean {
  return model.more.some((t) => t.key === active);
}

const BADGE_MAX = 99;

/** Globo de una sección de abajo y lo que lee el lector de pantalla (null = sin globo). */
export function navBadge(
  key: TabKey,
  counts: { incidents: number | null; approvals: number | null },
): { text: string; spoken: string } | null {
  const count = key === 'incidents' ? counts.incidents : key === 'approvals' ? counts.approvals : null;
  const text = badgeText(count ?? 0);
  if (!text || count === null) return null;
  return { text, spoken: key === 'incidents' ? `${count} abiertas` : `${count} por aprobar` };
}

/** Número del globo: nada con 0; "99+" desde 100. */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(Math.floor(count));
}
