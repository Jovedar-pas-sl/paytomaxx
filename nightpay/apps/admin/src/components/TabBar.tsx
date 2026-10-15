'use client';

import { useRef, type CSSProperties, type KeyboardEvent } from 'react';

export interface TabItem<K extends string> {
  key: K;
  label: string;
}

interface Props<K extends string> {
  tabs: readonly TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  /** Nombre de la barra para lectores de pantalla. */
  ariaLabel: string;
  /** Prefijo de los ids de pestaña y panel (único en la página). */
  idPrefix: string;
  size?: 'md' | 'sm';
}

export function tabId(prefix: string, key: string): string {
  return `${prefix}-tab-${key}`;
}

export function tabPanelId(prefix: string, key: string): string {
  return `${prefix}-panel-${key}`;
}

/**
 * Pestañas accesibles (role=tablist/tab, aria-selected, flechas e Inicio/Fin)
 * que se desplazan en horizontal en el móvil en vez de salirse de la pantalla.
 * El contenido va en un elemento con role="tabpanel" e id={tabPanelId(...)}.
 */
export function TabBar<K extends string>({ tabs, active, onChange, ariaLabel, idPrefix, size = 'md' }: Props<K>) {
  const buttons = useRef(new Map<K, HTMLButtonElement>());

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = tabs.length - 1;
    const target =
      e.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : e.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (target === null) return;
    const tab = tabs[target];
    if (!tab) return;
    e.preventDefault();
    onChange(tab.key);
    buttons.current.get(tab.key)?.focus();
  }

  return (
    <div role="tablist" aria-label={ariaLabel} style={listStyle}>
      {tabs.map((t, i) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            ref={(el) => {
              if (el) buttons.current.set(t.key, el);
              else buttons.current.delete(t.key);
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, t.key)}
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, t.key)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            style={{
              ...(size === 'sm' ? tabSm : tabMd),
              color: selected ? 'var(--np-accent)' : 'var(--np-text-mute)',
              borderBottom: selected ? '2px solid var(--np-accent)' : '2px solid transparent',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

const listStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  borderBottom: '1px solid var(--np-border)',
  overflowX: 'auto',
  overflowY: 'hidden',
  scrollbarWidth: 'thin',
  WebkitOverflowScrolling: 'touch',
  maxWidth: '100%',
};

const tabBase: CSSProperties = {
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
  background: 'transparent',
  border: 'none',
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const tabMd: CSSProperties = { ...tabBase, padding: '0.625rem 1.25rem', fontSize: '0.95rem' };
const tabSm: CSSProperties = { ...tabBase, padding: '0.5rem 1rem' };
