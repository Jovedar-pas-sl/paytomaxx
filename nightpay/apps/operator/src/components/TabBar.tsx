'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { TabKey } from '@/lib/roles';
import { TAB_BAR_HEIGHT } from './layout';

const TAB_LABEL: Record<TabKey, string> = {
  home: 'Inicio',
  wallet: 'Saldo',
  reception: 'Recepción',
  pos: 'POS',
  payments: 'Cobros',
  earnings: 'Ganancias',
};

/** Barra de pestañas de abajo: solo las del rol (ver roleAccess). */
export function TabBar({ tabs, active, onSelect }: { tabs: readonly TabKey[]; active: TabKey; onSelect: (tab: TabKey) => void }) {
  return (
    <nav style={tabBarStyle} aria-label="Navegación principal">
      {tabs.map((key) => (
        <TabBtn
          key={key}
          active={active === key}
          icon={<TabIcon tab={key} active={active === key} />}
          label={TAB_LABEL[key]}
          onClick={() => onSelect(key)}
        />
      ))}
    </nav>
  );
}

function TabBtn({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      style={{ ...tabBtnStyle, color: active ? 'var(--np-accent)' : 'var(--np-text-mute)' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '1.5rem' }}>{icon}</span>
      {label}
    </button>
  );
}

// SVG icons — consistentes en todas las plataformas, no dependen de fonts
// del sistema. Stroke-currentColor para heredar el color activo/inactivo.
const ICON_SIZE = 22;

function TabIcon({ tab, active }: { tab: TabKey; active: boolean }) {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON_PATHS[tab]}
    </svg>
  );
}

const ICON_PATHS: Record<TabKey, ReactNode> = {
  home: <path d="M3 12L12 3l9 9M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" />,
  wallet: (
    <>
      <path d="M20 12V8a2 2 0 00-2-2H5a1 1 0 01-1-1m0 0a1 1 0 011-1h14v4M4 5v14a2 2 0 002 2h12a2 2 0 002-2v-4" />
      <circle cx="17" cy="13" r="1.5" />
    </>
  ),
  reception: (
    <>
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M7 7V5a2 2 0 012-2h6a2 2 0 012 2v2M12 11v4M10 13h4" />
    </>
  ),
  pos: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 7h8M8 11h8M9 16h2" />
    </>
  ),
  payments: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </>
  ),
  earnings: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </>
  ),
};

// Alto fijo (TAB_BAR_HEIGHT): el botón de cobrar se queda pegado justo encima.
// Etiquetas a 0.8125rem y sin mayúsculas: «Ganancias» cabe en 4 pestañas a 320 px.
const tabBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  flex: 1,
  minWidth: 0,
  height: TAB_BAR_HEIGHT,
  padding: '0.5rem 0',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  cursor: 'pointer',
  fontSize: 'var(--np-t-label)',
  lineHeight: 1.2,
  letterSpacing: '0.01em',
  fontWeight: 600,
};

const tabBarStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  background: 'var(--np-surface)',
  borderTop: '1px solid var(--np-border)',
  display: 'flex',
  maxWidth: '32rem',
  margin: '0 auto',
  // iOS home indicator inset — el área debajo del último tab queda
  // segura para gesture home.
  paddingBottom: 'env(safe-area-inset-bottom)',
};
