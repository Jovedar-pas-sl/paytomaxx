'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { TabKey } from '@/lib/roles';
import { TAB_BAR_HEIGHT } from './layout';

const TAB_LABEL: Record<TabKey, string> = {
  home: 'Inicio',
  reception: 'Recepción',
  pos: 'POS',
  payments: 'Cobros',
  earnings: 'Ganancias',
};

/**
 * La pestaña elegida, en lima (--np-accent: lima en oscuro, que es el del
 * personal; 11:1 sobre --np-surface). Las demás, en t2 (--np-text-mute).
 */
const TAB_ACTIVE_COLOR = 'var(--np-accent)';
const TAB_IDLE_COLOR = 'var(--np-text-mute)';

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
      // La activa en lima (icono, texto y su raya arriba): la lima marca lo elegido. Las demás, en t2.
      style={{ ...tabBtnStyle, color: active ? TAB_ACTIVE_COLOR : TAB_IDLE_COLOR, fontWeight: active ? 600 : 500 }}
    >
      {active ? <span aria-hidden="true" style={activeMarkStyle} /> : null}
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
  // El timbre del mostrador (antes, un maletín con una cruz: parecía un botiquín).
  reception: (
    <>
      <path d="M4 18a8 8 0 0116 0" />
      <path d="M2.5 18h19M12 10V7.5M10 7.5h4" />
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
  // Una cartera (antes, un cilindro: el icono de una base de datos).
  earnings: (
    <>
      <path d="M17 7V5.5A1.5 1.5 0 0015.5 4H5a2 2 0 00-2 2" />
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M21 11h-4a2 2 0 000 4h4" />
      <circle cx="17" cy="13" r="0.5" fill="currentColor" />
    </>
  ),
};

// Alto fijo (TAB_BAR_HEIGHT): el botón de cobrar se queda pegado justo encima.
// Etiquetas a --np-t-label (14 px en el móvil) y sin mayúsculas: «Ganancias» cabe en 4 pestañas a 320 px.
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
  position: 'relative',
  fontSize: 'var(--np-t-label)',
  lineHeight: 1.2,
};

// Raya de 2 px arriba de la pestaña activa (con el color nunca va sola: también la letra y el trazo).
const activeMarkStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: '50%',
  width: '1.5rem',
  height: 2,
  marginLeft: '-0.75rem',
  borderRadius: 999,
  background: 'currentColor',
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
