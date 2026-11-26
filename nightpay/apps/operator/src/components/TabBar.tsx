'use client';

import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { Icon, type IconName } from '@nightpay/ui';
import { isParty } from '@/lib/edition';
import { PARTY_TAB_LABEL } from '@/lib/party-tabs';
import type { TabKey } from '@/lib/roles';
import { TAB_BAR_HEIGHT } from './layout';

const TAB_LABEL: Record<TabKey, string> = {
  home: 'Inicio',
  reception: 'Recepción',
  reservas: 'Reservados',
  pos: 'POS',
  payments: 'Cobros',
  earnings: 'Ganancias',
  settings: 'Ajustes',
};

/**
 * La pestaña elegida, en crema (tinta en el tema claro: --np-chosen); la lima
 * es solo para lo que se toca (el botón de la acción principal). Las demás, en
 * t2 (--np-text-mute).
 */
const TAB_ACTIVE_COLOR = 'var(--np-chosen)';
const TAB_IDLE_COLOR = 'var(--np-text-mute)';

/**
 * Lo que ocupa la barra de verdad (con la zona segura y el filete), en
 * --np-tabbar-space: las páginas dejan ese hueco al final (PAGE_BOTTOM_SPACE)
 * y nada queda tapado debajo de la barra.
 */
function useMeasuredSpace() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--np-tabbar-space', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--np-tabbar-space');
    };
  }, []);
  return ref;
}

/** Barra de pestañas de abajo: solo las del rol (ver roleAccess). */
export function TabBar({ tabs, active, onSelect }: { tabs: readonly TabKey[]; active: TabKey; onSelect: (tab: TabKey) => void }) {
  const ref = useMeasuredSpace();
  // OxioParty: Cobrar, Taquilla, Cobros y Ajustes.
  const labels = isParty() ? PARTY_TAB_LABEL : TAB_LABEL;
  return (
    <nav ref={ref} style={tabBarStyle} aria-label="Navegación principal" data-np-foot="">
      {tabs.map((key) => (
        <TabBtn key={key} tab={key} active={active === key} label={labels[key]} onClick={() => onSelect(key)} />
      ))}
    </nav>
  );
}

function TabBtn({ tab, active, label, onClick }: { tab: TabKey; active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="np-staff-tab"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      // La activa en crema (icono, texto y su raya arriba). Las demás, en t2.
      style={{ ...tabBtnStyle, color: active ? TAB_ACTIVE_COLOR : TAB_IDLE_COLOR, fontWeight: active ? 600 : 500 }}
    >
      {active ? <span aria-hidden="true" style={activeMarkStyle} /> : null}
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '1.5rem' }}>
        <Icon name={TAB_ICON[tab]} />
      </span>
      {label}
    </button>
  );
}

/** El dibujo de cada pestaña (la pieza Icon, a 24). La elegida engorda el trazo por CSS (.np-staff-tab en staff.css). */
const TAB_ICON: Record<TabKey, IconName> = {
  home: 'home',
  // El timbre del mostrador.
  reception: 'concierge-bell',
  // Una entrada con su corte: los reservados.
  reservas: 'ticket',
  pos: 'pos',
  payments: 'list',
  earnings: 'wallet',
  // Ajustes (OxioParty): dos correderas.
  settings: 'sliders',
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
  background: 'var(--np-sunk)',
  borderTop: '1px solid var(--np-border)',
  display: 'flex',
  maxWidth: '32rem',
  margin: '0 auto',
  // iOS home indicator inset — el área debajo del último tab queda
  // segura para gesture home.
  paddingBottom: 'env(safe-area-inset-bottom)',
};
