'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';

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
  /** Clase extra (p. ej. para ocultarla en el móvil, donde va la barra de abajo). */
  className?: string;
  /** Globo con un número junto a la etiqueta (p. ej. lo que hay por aprobar) y lo que se lee. */
  badges?: Partial<Record<K, { text: string; spoken: string } | null>>;
  /** Pestañas que aún no se sabe si salen: una silueta en su sitio (la abierta siempre se pinta). */
  pending?: readonly K[];
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
 * Estilos (activa, hover, foco) en styles/panel-nav.css.
 */
export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  idPrefix,
  size = 'md',
  className,
  badges,
  pending,
}: Props<K>) {
  const buttons = useRef(new Map<K, HTMLButtonElement>());

  // En el móvil la barra se desplaza: la pestaña abierta, siempre a la vista
  // (antes podía quedar cortada en el borde). Solo en horizontal.
  useEffect(() => {
    const el = buttons.current.get(active);
    const bar = el?.parentElement;
    if (!el || !bar || bar.scrollWidth <= bar.clientWidth) return;
    const b = bar.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const MARGIN = 16;
    if (r.left < b.left) bar.scrollLeft -= b.left - r.left + MARGIN;
    else if (r.right > b.right) bar.scrollLeft += r.right - b.right + MARGIN;
  }, [active]);

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
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-size={size}
      className={['np-tabbar', className].filter(Boolean).join(' ')}
    >
      {tabs.map((t, i) => {
        const selected = t.key === active;
        const badge = badges?.[t.key] ?? null;
        if (!selected && pending?.includes(t.key)) {
          return (
            <span key={t.key} className="np-tab np-tab-skel" aria-hidden="true">
              <span className="np-skel" style={{ width: '5.5rem', height: '1rem' }} />
            </span>
          );
        }
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
            className="np-tab"
          >
            {t.label}
            {badge ? (
              <>
                <span className="np-tab-badge" aria-hidden="true">
                  {badge.text}
                </span>
                <span className="np-sr-only">, {badge.spoken}</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
