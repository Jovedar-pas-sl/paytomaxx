'use client';

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string;
}

/** Modales abiertos, de abajo arriba: Esc, Tab y el foco solo los atiende el de encima. */
let openModals: readonly symbol[] = [];

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/**
 * Ventana encima de la página. Se cierra con Esc o con la ✕, no al pulsar
 * fuera: un toque sin querer no se lleva lo que se estaba escribiendo. Tab no
 * sale de la ventana y, al cerrarla, el foco vuelve a donde estaba.
 */
export function Modal({ open, onClose, title, children, width = '28rem' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    return trapFocus(panel, () => onCloseRef.current());
  }, [open]);

  if (!open) return null;

  return (
    <div style={overlay}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className="np-modal-panel"
        style={{ ...content, width }}
      >
        <div style={header}>
          {title ? (
            <h3 id={titleId} style={titleStyle}>
              {title}
            </h3>
          ) : null}
          <button type="button" className="np-modal-close" aria-label="Cerrar" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Mientras está abierto: foco dentro, Esc cierra, scroll de fondo parado. Devuelve el "deshacer". */
function trapFocus(panel: HTMLElement, close: () => void): () => void {
  const id = Symbol('modal');
  openModals = [...openModals, id];
  const isTop = () => openModals[openModals.length - 1] === id;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Un autoFocus de dentro manda; si no, el foco va a la ventana (se lee el título).
  if (!panel.contains(document.activeElement)) panel.focus();

  function onKeyDown(e: KeyboardEvent) {
    if (!isTop() || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      cycleTab(e, panel);
    }
  }
  function onFocusIn(e: FocusEvent) {
    if (isTop() && e.target instanceof Node && !panel.contains(e.target)) panel.focus();
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('focusin', onFocusIn);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  return () => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('focusin', onFocusIn);
    document.body.style.overflow = prevOverflow;
    openModals = openModals.filter((m) => m !== id);
    if (previous?.isConnected) previous.focus();
  };
}

/** Tab en el último elemento vuelve al primero (y Mayús+Tab al revés). */
function cycleTab(e: KeyboardEvent, panel: HTMLElement): void {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--np-backdrop)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1rem',
  zIndex: 100,
  animation: 'np-fade-in var(--np-d-base) var(--np-ease)',
};

// max-height en .np-modal-panel (90dvh, con 90vh de respaldo). Flota: radio de
// tarjeta y la sombra grande del relieve (antes, una sombra en oklch() que un
// navegador viejo no pintaba).
const content: CSSProperties = {
  position: 'relative',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-card)',
  padding: 'var(--np-s-6)',
  overflowY: 'auto',
  boxShadow: 'var(--np-shadow-2)',
  animation: 'np-modal-in var(--np-d-base) var(--np-ease)',
};

const header: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--np-s-4)',
  marginBottom: 'var(--np-s-4)',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h3)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--np-text)',
};
