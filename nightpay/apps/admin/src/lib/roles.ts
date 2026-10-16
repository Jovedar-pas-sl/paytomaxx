// Quién entra al panel y qué pestañas ve. Refleja los @Roles del API: una
// pestaña cuyos endpoints son solo del dueño no se enseña al encargado (antes
// la veía y todo le daba 403).

export type PanelRole = 'OWNER' | 'MANAGER';

/** Solo dueño y encargado usan el panel; camareros y chicas tienen sus apps. */
export function canUsePanel(role: string | null | undefined): role is PanelRole {
  return role === 'OWNER' || role === 'MANAGER';
}

export type TabKey =
  | 'payments'
  | 'nights'
  | 'incidents'
  | 'bank'
  | 'operators'
  | 'carta'
  | 'reports'
  | 'wallets'
  | 'treasury'
  | 'terminals'
  | 'settings'
  | 'superadmin';

type TabAccess = 'staff' | 'owner' | 'superadmin';

export interface PanelTab {
  key: TabKey;
  label: string;
  access: TabAccess;
}

export const PANEL_TABS: readonly PanelTab[] = [
  { key: 'payments', label: 'Pagos', access: 'staff' },
  { key: 'nights', label: 'Noches', access: 'staff' },
  { key: 'incidents', label: 'Incidencias', access: 'staff' },
  // /v1/bank-recon/*: solo OWNER.
  { key: 'bank', label: 'Banco', access: 'owner' },
  { key: 'operators', label: 'Operadoras', access: 'staff' },
  { key: 'carta', label: 'Carta', access: 'staff' },
  // /v1/admin/export/*: solo OWNER.
  { key: 'reports', label: 'Informes', access: 'owner' },
  { key: 'wallets', label: 'Wallets', access: 'staff' },
  { key: 'treasury', label: 'Treasury', access: 'staff' },
  { key: 'terminals', label: 'Datáfonos', access: 'staff' },
  { key: 'settings', label: 'Ajustes', access: 'staff' },
  // Consola de toda la plataforma (components/superadmin).
  { key: 'superadmin', label: 'Super admin', access: 'superadmin' },
];

export function visibleTabs(user: { role: string; isSuperAdmin?: boolean }): PanelTab[] {
  if (!canUsePanel(user.role)) return [];
  return PANEL_TABS.filter((t) => {
    if (t.access === 'owner') return user.role === 'OWNER';
    if (t.access === 'superadmin') return Boolean(user.isSuperAdmin);
    return true;
  });
}
