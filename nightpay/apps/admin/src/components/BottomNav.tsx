'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { badgeText, bottomNavItems, isMoreActive } from '@/lib/bottom-nav';
import type { PanelTab, TabKey } from '@/lib/roles';

interface Props {
  tabs: readonly PanelTab[];
  active: TabKey;
  onChange: (key: TabKey) => void;
  /** Incidencias abiertas (null = aún no se sabe). */
  openIncidents: number | null;
  /** Cuenta y «Salir»: en el móvil viven en «Más». */
  account: ReactNode;
}

/**
 * Barra fija de abajo en el móvil (en escritorio no se pinta: styles/panel-nav.css):
 * Pagos · Noche · Incidencias · Chicas · Más. «Más» abre una hoja con el resto
 * de pestañas que ese rol ve, y la cuenta.
 */
export function BottomNav({ tabs, active, onChange, openIncidents, account }: Props) {
  const model = bottomNavItems(tabs);
  const [sheetOpen, setSheetOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreActive = isMoreActive(model, active);
  const activeMore = model.more.find((t) => t.key === active);

  function go(key: TabKey): void {
    setSheetOpen(false);
    onChange(key);
  }

  return (
    <>
      <nav className="np-bottomnav" aria-label="Secciones del panel">
        <ul>
          {model.primary.map((item) => {
            const badge = item.key === 'incidents' ? badgeText(openIncidents ?? 0) : '';
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className="np-bottomnav-item"
                  aria-current={item.key === active ? 'page' : undefined}
                  onClick={() => go(item.key)}
                >
                  <span className="np-bottomnav-icon">
                    <NavIcon name={item.key} />
                    {badge ? (
                      <span className="np-bottomnav-badge" aria-hidden="true">
                        {badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="np-bottomnav-label">{item.label}</span>
                  {badge ? <span className="np-sr-only">, {openIncidents} abiertas</span> : null}
                </button>
              </li>
            );
          })}
          {model.more.length > 0 ? (
            <li>
              <button
                ref={moreButton}
                type="button"
                className="np-bottomnav-item"
                aria-haspopup="dialog"
                aria-expanded={sheetOpen}
                aria-current={moreActive ? 'page' : undefined}
                onClick={() => setSheetOpen(true)}
              >
                <span className="np-bottomnav-icon">
                  <NavIcon name="more" />
                </span>
                <span className="np-bottomnav-label">{activeMore ? activeMore.label : 'Más'}</span>
                {activeMore ? <span className="np-sr-only"> (más secciones)</span> : null}
              </button>
            </li>
          ) : null}
        </ul>
      </nav>

      <MoreSheet
        open={sheetOpen}
        tabs={model.more}
        active={active}
        onPick={go}
        onClose={() => setSheetOpen(false)}
        returnFocus={moreButton}
      >
        {account}
      </MoreSheet>
    </>
  );
}

/**
 * Hoja de abajo con <dialog> nativo: foco dentro, Esc cierra y el fondo no se
 * toca. Al cerrar, el foco vuelve a «Más».
 */
function MoreSheet({
  open,
  tabs,
  active,
  onPick,
  onClose,
  returnFocus,
  children,
}: {
  open: boolean;
  tabs: readonly PanelTab[];
  active: TabKey;
  onPick: (key: TabKey) => void;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return undefined;
    function onNativeClose(): void {
      onClose();
      returnFocus.current?.focus();
    }
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, [onClose, returnFocus]);

  return (
    <dialog
      ref={dialog}
      className="np-sheet"
      aria-labelledby={titleId}
      onClick={(e) => {
        // Tocar el fondo (fuera de la hoja) la cierra.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="np-sheet-panel">
          <div className="np-sheet-grip" aria-hidden="true" />
          <div className="np-sheet-head">
            <h2 id={titleId} className="np-sheet-title">
              Más secciones
            </h2>
            <button type="button" className="np-modal-close" aria-label="Cerrar" onClick={onClose}>
              <NavIcon name="close" />
            </button>
          </div>
          <ul className="np-sheet-list">
            {tabs.map((t) => (
              <li key={t.key}>
                <button
                  type="button"
                  className="np-sheet-link"
                  aria-current={t.key === active ? 'page' : undefined}
                  onClick={() => onPick(t.key)}
                >
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="np-sheet-account">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

type IconName = 'payments' | 'nights' | 'incidents' | 'operators' | 'more' | 'close' | TabKey;

const ICON_PATHS: Partial<Record<IconName, string>> = {
  payments: 'M3 7h18v10H3zM3 11h18M7 15h3',
  nights: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  incidents: 'M12 4v9M12 17.5v.5M10.3 3.6 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z',
  operators: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
};

function NavIcon({ name }: { name: IconName }) {
  const d = ICON_PATHS[name] ?? ICON_PATHS.more;
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
