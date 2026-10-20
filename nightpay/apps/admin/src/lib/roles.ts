// Quién entra al panel y qué ve. Cinco secciones (Hoy, Chicas, Clientes,
// Informes, Ajustes) y, dentro, sus pestañas. Refleja los @Roles del API: lo
// que es solo del dueño no se enseña al encargado (antes lo veía y todo le
// daba 403); los informes, solo si el dueño se los deja (Ajustes → Permisos).

export type PanelRole = 'OWNER' | 'MANAGER';

/** Solo dueño y encargado usan el panel; camareros y chicas tienen sus apps. */
export function canUsePanel(role: string | null | undefined): role is PanelRole {
  return role === 'OWNER' || role === 'MANAGER';
}

export type SectionKey = 'hoy' | 'chicas' | 'clientes' | 'informes' | 'ajustes';

/** Pestaña dentro de una sección. */
export type TabKey =
  | 'payments'
  | 'incidents'
  | 'operators'
  | 'treasury'
  | 'wallets'
  | 'fichas'
  | 'nights'
  | 'reports'
  | 'bank'
  | 'carta'
  | 'sections'
  | 'terminals'
  | 'rules'
  | 'methods'
  | 'night'
  | 'permissions'
  | 'alerts'
  | 'security'
  | 'superadmin';

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
  chicas: 'Chicas',
  clientes: 'Clientes',
  informes: 'Informes',
  ajustes: 'Ajustes',
};

const SECTION_ORDER: readonly SectionKey[] = ['hoy', 'chicas', 'clientes', 'informes', 'ajustes'];

export const PANEL_TABS: readonly PanelTab[] = [
  // Hoy: los cobros en vivo y una sola bandeja (incidencias + «Por aprobar»).
  { key: 'payments', label: 'Cobros', section: 'hoy', access: 'staff' },
  { key: 'incidents', label: 'Avisos', section: 'hoy', access: 'staff' },
  { key: 'operators', label: 'Chicas', section: 'chicas', access: 'staff' },
  { key: 'treasury', label: 'Pagos a chicas', section: 'chicas', access: 'staff' },
  { key: 'wallets', label: 'Saldos', section: 'clientes', access: 'staff' },
  // Fichas NFC: stock, entregadas y perdidas por noche (/v1/wallet-cards).
  { key: 'fichas', label: 'Fichas', section: 'clientes', access: 'staff' },
  { key: 'nights', label: 'Noches', section: 'informes', access: 'staff' },
  // /v1/admin/export/*: el dueño (y el encargado con permiso).
  { key: 'reports', label: 'Informes', section: 'informes', access: 'reports' },
  // /v1/bank-recon/*: solo OWNER.
  { key: 'bank', label: 'Banco', section: 'informes', access: 'owner' },
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

export interface PanelViewer {
  role: string;
  isSuperAdmin?: boolean;
  /** El encargado puede ver los informes (Ajustes → Permisos del dueño). */
  canSeeReports?: boolean;
  /** El local cobra con datáfono (Formas de cobro). Sin saberlo, sí: como antes. */
  posOn?: boolean;
}

export function visibleTabs(user: PanelViewer): PanelTab[] {
  if (!canUsePanel(user.role)) return [];
  const isOwner = user.role === 'OWNER';
  return PANEL_TABS.filter((t) => {
    if (t.needsPos && user.posOn === false) return false;
    if (t.access === 'owner') return isOwner;
    if (t.access === 'reports') return isOwner || Boolean(user.canSeeReports);
    if (t.access === 'superadmin') return Boolean(user.isSuperAdmin);
    return true;
  });
}

/** Las secciones con alguna pestaña para este rol, en orden. */
export function visibleSections(user: PanelViewer): PanelSection[] {
  const tabs = visibleTabs(user);
  return SECTION_ORDER.map((key) => ({ key, label: SECTION_LABELS[key], tabs: tabs.filter((t) => t.section === key) })).filter(
    (s) => s.tabs.length > 0,
  );
}

export function sectionOf(key: TabKey): SectionKey {
  return PANEL_TABS.find((t) => t.key === key)?.section ?? 'hoy';
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

export function resolveTab(key: string): TabKey | null {
  if (PANEL_TABS.some((t) => t.key === key)) return key as TabKey;
  return LEGACY_TABS[key] ?? null;
}
