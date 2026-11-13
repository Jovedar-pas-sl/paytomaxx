// Quién entra al panel y qué ve. Cinco secciones (Hoy, Chicas, Clientes,
// Informes, Ajustes) y, dentro, sus pestañas. Refleja los @Roles del API: lo
// que es solo del dueño no se enseña al encargado (antes lo veía y todo le
// daba 403); los informes, solo si el dueño se los deja (Ajustes → Permisos).
//
// OxioParty (NEXT_PUBLIC_EDITION=party): otras seis secciones (En directo,
// Casetas, Pulseras, Devoluciones, Cierre y Ajustes) y nada de lo que es solo
// de OxioPay (compañeras y sus pagos, invitaciones, habitaciones, bitcoin…).

import type { Edition } from '@nightpay/contracts';
import { PANEL_EDITION } from './edition';

export type PanelRole = 'OWNER' | 'MANAGER';

/** Solo dueño y encargado usan el panel; camareros y chicas tienen sus apps. */
export function canUsePanel(role: string | null | undefined): role is PanelRole {
  return role === 'OWNER' || role === 'MANAGER';
}

export type ClubSectionKey = 'hoy' | 'chicas' | 'clientes' | 'informes' | 'ajustes';
/** Las de OxioParty (Ajustes es la misma: ?s=ajustes en las dos). */
export type PartySectionKey = 'directo' | 'casetas' | 'pulseras' | 'devoluciones' | 'cierre' | 'ajustes';
export type SectionKey = ClubSectionKey | PartySectionKey;

/** Pestaña dentro de una sección. */
export type TabKey =
  | 'payments'
  | 'money'
  | 'incidents'
  | 'operators'
  | 'treasury'
  | 'wallets'
  | 'fichas'
  | 'nights'
  | 'reports'
  | 'bank'
  | 'oxiopay'
  | 'carta'
  | 'sections'
  | 'terminals'
  | 'rules'
  | 'methods'
  | 'night'
  | 'permissions'
  | 'alerts'
  | 'security'
  | 'superadmin'
  // OxioParty.
  | 'live'
  | 'stalls'
  | 'wristbands'
  | 'partyRefunds'
  | 'settlement'
  | 'party';

/**
 *  - staff: dueño y encargado.
 *  - owner: solo el dueño (sus endpoints son del dueño).
 *  - reports: el dueño, y el encargado si el dueño le deja ver los informes.
 *  - superadmin: la consola de toda la plataforma.
 */
type TabAccess = 'staff' | 'owner' | 'reports' | 'superadmin';

export interface PanelTab {
  key: TabKey;
  label: string;
  section: SectionKey;
  access: TabAccess;
  /** Solo si el local cobra con datáfono (Ajustes → Formas de cobro → Datáfono). */
  needsPos?: true;
}

export interface PanelSection {
  key: SectionKey;
  label: string;
  /** Las pestañas que ve este rol, en orden (al menos una). */
  tabs: PanelTab[];
}

export const SECTION_LABELS: Readonly<Record<SectionKey, string>> = {
  hoy: 'Hoy',
  chicas: 'Compañeras',
  clientes: 'Clientes',
  informes: 'Informes',
  ajustes: 'Ajustes',
  directo: 'En directo',
  casetas: 'Casetas',
  pulseras: 'Pulseras',
  devoluciones: 'Devoluciones',
  cierre: 'Cierre',
};

const SECTION_ORDER: readonly SectionKey[] = ['hoy', 'chicas', 'clientes', 'informes', 'ajustes'];
const PARTY_SECTION_ORDER: readonly PartySectionKey[] = ['directo', 'casetas', 'pulseras', 'devoluciones', 'cierre', 'ajustes'];

export const PANEL_TABS: readonly PanelTab[] = [
  // Hoy: los cobros en vivo y una sola bandeja (incidencias + «Por aprobar»).
  { key: 'payments', label: 'Cobros', section: 'hoy', access: 'staff' },
  // El mapa del dinero en directo (/v1/admin/money-map): como los informes.
  { key: 'money', label: 'Mapa del dinero', section: 'hoy', access: 'reports' },
  { key: 'incidents', label: 'Avisos', section: 'hoy', access: 'staff' },
  { key: 'operators', label: 'Compañeras', section: 'chicas', access: 'staff' },
  { key: 'treasury', label: 'Pagos a compañeras', section: 'chicas', access: 'staff' },
  { key: 'wallets', label: 'Saldos', section: 'clientes', access: 'staff' },
  // Fichas NFC: stock, entregadas y perdidas por noche (/v1/wallet-cards).
  { key: 'fichas', label: 'Fichas', section: 'clientes', access: 'staff' },
  { key: 'nights', label: 'Noches', section: 'informes', access: 'staff' },
  // /v1/admin/export/*: el dueño (y el encargado con permiso).
  { key: 'reports', label: 'Informes', section: 'informes', access: 'reports' },
  // /v1/bank-recon/*: solo OWNER.
  { key: 'bank', label: 'Banco', section: 'informes', access: 'owner' },
  // Lo que el local debe a OxioPay cada semana (/v1/admin/oxiopay-settlements): solo el dueño, solo lectura.
  { key: 'oxiopay', label: 'Liquidaciones OxioPay', section: 'informes', access: 'owner' },
  { key: 'carta', label: 'Carta', section: 'ajustes', access: 'staff' },
  // El mapa del dinero: nombre, color y si se usa cada sección (/v1/admin/venue/sections).
  { key: 'sections', label: 'Secciones', section: 'ajustes', access: 'owner' },
  // Datáfonos PAX: con el datáfono apagado no sale (su código sigue, por si vuelve).
  { key: 'terminals', label: 'Datáfonos', section: 'ajustes', access: 'staff', needsPos: true },
  { key: 'rules', label: 'Reglas del local', section: 'ajustes', access: 'owner' },
  { key: 'methods', label: 'Formas de cobro', section: 'ajustes', access: 'owner' },
  // NFC sin PIN, teclado del PIN, recepción y avisos al cobrar (/v1/admin/venue/night).
  { key: 'night', label: 'Noche', section: 'ajustes', access: 'owner' },
  { key: 'permissions', label: 'Permisos', section: 'ajustes', access: 'owner' },
  { key: 'alerts', label: 'Telegram', section: 'ajustes', access: 'owner' },
  { key: 'security', label: 'Seguridad', section: 'ajustes', access: 'staff' },
  // Consola de toda la plataforma (components/superadmin).
  { key: 'superadmin', label: 'Super admin', section: 'ajustes', access: 'superadmin' },
];

/**
 * OxioParty: el panel del organizador. Las pestañas genéricas de OxioPay que
 * sirven en una fiesta (cobros, avisos, formas de cobro sin bitcoin, la
 * noche, datáfonos, seguridad) van en su sección; lo que es solo de OxioPay
 * (compañeras y sus pagos, saldos y fichas —ahora pulseras—, informes con la
 * parte de las compañeras, reglas, invitaciones, habitaciones, permisos y
 * Telegram de las compañeras) no sale.
 */
export const PARTY_TABS: readonly PanelTab[] = [
  // /v1/party/live: dueño y encargado.
  { key: 'live', label: 'En directo', section: 'directo', access: 'staff' },
  { key: 'payments', label: 'Cobros', section: 'directo', access: 'staff' },
  { key: 'incidents', label: 'Avisos', section: 'directo', access: 'staff' },
  // /v1/admin/party/stalls y /staff: dueño y encargado.
  { key: 'stalls', label: 'Casetas', section: 'casetas', access: 'staff' },
  { key: 'wristbands', label: 'Pulseras', section: 'pulseras', access: 'staff' },
  { key: 'partyRefunds', label: 'Devoluciones', section: 'devoluciones', access: 'staff' },
  // /v1/party/settlement: dueño y encargado.
  { key: 'settlement', label: 'Cierre', section: 'cierre', access: 'staff' },
  // /v1/admin/party/settings: los dos la ven; solo el dueño la cambia.
  { key: 'party', label: 'La fiesta', section: 'ajustes', access: 'staff' },
  { key: 'methods', label: 'Formas de cobro', section: 'ajustes', access: 'owner' },
  { key: 'night', label: 'Pulseras y PIN', section: 'ajustes', access: 'owner' },
  { key: 'terminals', label: 'Datáfonos', section: 'ajustes', access: 'staff', needsPos: true },
  { key: 'security', label: 'Seguridad', section: 'ajustes', access: 'staff' },
  { key: 'superadmin', label: 'Super admin', section: 'ajustes', access: 'superadmin' },
];

/** Las pestañas de una edición. */
export function tabsOf(edition: Edition = PANEL_EDITION): readonly PanelTab[] {
  return edition === 'party' ? PARTY_TABS : PANEL_TABS;
}

export interface PanelViewer {
  role: string;
  isSuperAdmin?: boolean;
  /** El encargado puede ver los informes (Ajustes → Permisos del dueño). */
  canSeeReports?: boolean;
  /** El local cobra con datáfono (Formas de cobro). Sin saberlo, sí: como antes. */
  posOn?: boolean;
}

export function visibleTabs(user: PanelViewer, edition: Edition = PANEL_EDITION): PanelTab[] {
  if (!canUsePanel(user.role)) return [];
  const isOwner = user.role === 'OWNER';
  return tabsOf(edition).filter((t) => {
    if (t.needsPos && user.posOn === false) return false;
    if (t.access === 'owner') return isOwner;
    if (t.access === 'reports') return isOwner || Boolean(user.canSeeReports);
    if (t.access === 'superadmin') return Boolean(user.isSuperAdmin);
    return true;
  });
}

/** Las secciones con alguna pestaña para este rol, en orden. */
export function visibleSections(user: PanelViewer, edition: Edition = PANEL_EDITION): PanelSection[] {
  const tabs = visibleTabs(user, edition);
  const order: readonly SectionKey[] = edition === 'party' ? PARTY_SECTION_ORDER : SECTION_ORDER;
  return order.map((key) => ({ key, label: SECTION_LABELS[key], tabs: tabs.filter((t) => t.section === key) })).filter(
    (s) => s.tabs.length > 0,
  );
}

export function sectionOf(key: TabKey, edition: Edition = PANEL_EDITION): SectionKey {
  return tabsOf(edition).find((t) => t.key === key)?.section ?? (edition === 'party' ? 'directo' : 'hoy');
}

/**
 * Nombres de antes (enlaces guardados en los paneles): «Por aprobar» y «Mis
 * solicitudes» están ahora en Avisos; «Ajustes» abre Seguridad (la 2FA).
 */
const LEGACY_TABS: Readonly<Record<string, TabKey>> = {
  approvals: 'incidents',
  requests: 'incidents',
  settings: 'security',
};

export function resolveTab(key: string, edition: Edition = PANEL_EDITION): TabKey | null {
  if (tabsOf(edition).some((t) => t.key === key)) return key as TabKey;
  const legacy = LEGACY_TABS[key];
  return legacy && tabsOf(edition).some((t) => t.key === legacy) ? legacy : null;
}
