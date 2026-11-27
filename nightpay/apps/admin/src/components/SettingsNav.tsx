'use client';

import type { ReactNode } from 'react';
import { Icon, Skeleton } from '@nightpay/ui';
import { settingsGroups, type PanelTab, type TabKey } from '@/lib/roles';

interface Props {
  /** Las pestañas de Ajustes que ve este rol (con su grupo, frase e icono). */
  tabs: readonly PanelTab[];
  active: TabKey;
  onChange: (key: TabKey) => void;
  /** Por debajo de 900: la lista sola o la pantalla de una fila (Dashboard). */
  view: 'list' | 'page';
  /** «‹ Ajustes»: de vuelta a la lista. */
  onBack: () => void;
  /** Filas que aún no se sabe si salen (Datáfonos): una silueta en su sitio. */
  pending: readonly TabKey[];
  /** La pantalla de la fila activa. */
  children: ReactNode;
}

/**
 * Ajustes como lista (entrega 10 A, idea 21), en lugar de las pastillas: los
 * grupos («El local», «El equipo», «Tu cuenta») con sus filas de 56 (icono,
 * nombre, frase y flecha). Desde 900 px, la lista a la izquierda y la pantalla
 * al lado; por debajo, primero la lista y, al tocar una fila, su pantalla con
 * «‹ Ajustes». Estilos en panel-2.css.
 */
export function SettingsNav({ tabs, active, onChange, view, onBack, pending, children }: Props) {
  return (
    <div className="np-settings" data-view={view}>
      <nav aria-label="Ajustes" className="np-setnav">
        {settingsGroups(tabs).map((group) => (
          <section key={group.key} className="np-setnav-group">
            <h2 className="np-setnav-title">{group.label}</h2>
            <ul className="np-setnav-list">
              {group.tabs.map((tab) =>
                pending.includes(tab.key) ? (
                  <li key={tab.key} aria-hidden="true">
                    <span className="np-setnav-row" data-pending="">
                      <Skeleton width="1.5rem" height="1.5rem" />
                      <span className="np-setnav-text">
                        <Skeleton width="45%" height="1rem" />
                        <Skeleton width="70%" height="0.875rem" />
                      </span>
                    </span>
                  </li>
                ) : (
                  <li key={tab.key}>
                    <button
                      type="button"
                      className="np-setnav-row"
                      aria-current={tab.key === active ? 'page' : undefined}
                      onClick={() => onChange(tab.key)}
                    >
                      {tab.icon ? <Icon name={tab.icon} size={24} className="np-setnav-icon" /> : null}
                      <span className="np-setnav-text">
                        <span className="np-setnav-name">{tab.label}</span>
                        {tab.hint ? <span className="np-setnav-hint">{tab.hint}</span> : null}
                      </span>
                      <Icon name="chevron-right" size={20} className="np-setnav-arrow" />
                    </button>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
      </nav>
      <div className="np-settings-page">
        <button type="button" className="np-settings-back" onClick={onBack}>
          <Icon name="chevron-left" size={20} />
          Ajustes
        </button>
        <div className="np-panel-view">{children}</div>
      </div>
    </div>
  );
}
