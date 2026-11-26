'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { menuPosition, openSheetEntry, sheetDragEnd } from '../lib/sheet';
import { IconButton } from './Icon';

interface SheetProps {
  open: boolean;
  /**
   * La ✕, Esc, «atrás» y arrastrar hacia abajo lo piden; decide quien la usa
   * (quien no deja cerrar mientras guarda, tampoco así). Tocar fuera no cierra.
   */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** El pie fijo: uno o dos botones, lado a lado. */
  footer?: ReactNode;
  /** Desde 641 px: ventana centrada (`dialog`), panel a la derecha (`side`) o menú bajo su botón (`menu`). */
  wide?: 'dialog' | 'side' | 'menu';
  /** Su ancho desde 641 px (sin decirlo: 28, 27.5 y 20rem). */
  width?: string;
  /** Hasta 640 px, la pantalla entera. */
  full?: boolean;
  /** El botón que abre el menú (`menu`): se pinta debajo de él. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** `alertdialog`: una pregunta que hay que contestar (ConfirmDialog). */
  role?: 'dialog' | 'alertdialog';
  describedBy?: string;
}

/** Hojas abiertas, de abajo arriba: Esc, Tab y el foco solo los atiende la de encima. */
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

/** Pantalla ancha (desde 641 px): la hoja ya no sube desde abajo. El tamaño lo pone el CSS; aquí solo para el menú y el arrastre. */
function isWide(): boolean {
  return Boolean(window.matchMedia?.('(min-width: 641px)').matches);
}

/**
 * La hoja: lo que se abre encima de la página para elegir, rellenar o
 * contestar. Hasta 640 px sube desde abajo, a lo ancho, con su asa; desde 641
 * es una ventana centrada, un panel a la derecha o un menú bajo su botón
 * (estilos en pieces-2.css: .np-hoja). Tab no sale de ella y, al cerrarla, el
 * foco vuelve a donde estaba. Modal es esta hoja.
 */
export function Sheet({ open, onClose, title, children, footer, wide = 'dialog', width, full, anchorRef, role = 'dialog', describedBy }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const sheetId = useId();
  // El menú en pantalla ancha flota bajo su botón: sin velo ni cabecera, y no es modal.
  const [floating, setFloating] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const drag = useRef<{ y: number; t: number } | null>(null);
  // Quién tenía el foco al abrirse, mirado al pintar: un autoFocus de dentro
  // («Volver» de ConfirmDialog) se lo lleva antes de que corra ningún efecto.
  const opener = useRef<{ el: HTMLElement | null } | null>(null);
  if (!open) opener.current = null;
  else if (opener.current === null && typeof document !== 'undefined') {
    const active = document.activeElement;
    opener.current = { el: active instanceof HTMLElement ? active : null };
  }

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // El menú flota solo en pantalla ancha: si la pantalla cruza los 641 px con él abierto, cambia.
  useLayoutEffect(() => {
    if (!open || wide !== 'menu') {
      setFloating(false);
      return undefined;
    }
    const query = window.matchMedia?.('(min-width: 641px)');
    const update = () => setFloating(isWide());
    update();
    if (!query) return undefined;
    // Chrome 64 y Safari viejo: addListener.
    if (query.addEventListener) query.addEventListener('change', update);
    else query.addListener?.(update);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', update);
      else query.removeListener?.(update);
    };
  }, [open, wide]);

  // El foco, atrapado mientras está abierta y devuelto a quien la abrió. Solo depende de `open`: un cambio de tamaño no lo toca.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return undefined;
    return trapFocus(panel, () => onCloseRef.current(), opener.current?.el ?? null);
  }, [open]);

  // «Atrás» la cierra. El menú ancho no: es parte de la página. Aparte del foco, para que cruzar los 641 px no lo mueva.
  useEffect(() => {
    // Se mira la pantalla de ahora (no solo `floating`): al abrirse, el menú ancho no deja ni un instante su entrada.
    if (!open || (wide === 'menu' && isWide())) return undefined;
    return openSheetEntry(sheetId, () => onCloseRef.current());
  }, [open, wide, floating, sheetId]);

  // El menú, bajo su botón (o encima si no cabe).
  useLayoutEffect(() => {
    if (!floating) return undefined;
    const place = () => {
      const anchor = anchorRef?.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      setAt(menuPosition(anchor.getBoundingClientRect(), { width: panel.offsetWidth, height: panel.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [floating, anchorRef]);

  if (!open) return null;

  // Arrastrar hacia abajo desde el asa o la cabecera (solo la hoja de abajo): la hoja sigue al dedo.
  function dragStart(e: PointerEvent<HTMLDivElement>): void {
    const panel = panelRef.current;
    // La ✕ se pulsa, no arrastra.
    if (!panel || isWide() || (e.target as Element).closest('button')) return;
    drag.current = { y: e.clientY, t: Date.now() };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Sin captura se arrastra igual mientras el dedo siga en la cabecera.
    }
    panel.style.transition = 'none';
  }
  function dragMove(e: PointerEvent<HTMLDivElement>): void {
    const panel = panelRef.current;
    if (!drag.current || !panel) return;
    panel.style.transform = `translateY(${Math.max(0, e.clientY - drag.current.y)}px)`;
  }
  function dragEnd(e: PointerEvent<HTMLDivElement>): void {
    const panel = panelRef.current;
    const from = drag.current;
    drag.current = null;
    if (!from || !panel) return;
    // Vuelve a su sitio en 200 ms: también si quien la usa no la cierra.
    panel.style.transition = 'transform 200ms var(--np-ease)';
    panel.style.transform = '';
    if (e.type === 'pointerup' && sheetDragEnd(e.clientY - from.y, Date.now() - from.t, panel.offsetHeight)) onClose();
  }

  const style = { ...(width ? { '--np-hoja-w': width } : null), ...(floating ? at : null) } as CSSProperties;

  return (
    <div
      className="np-hoja-velo"
      data-wide={wide}
      data-floating={floating ? '' : undefined}
      // El velo no cierra una ventana (un toque sin querer no se lleva lo escrito); tocar fuera de un menú, sí.
      onClick={
        floating
          ? (e) => {
              if (e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal={floating ? undefined : true}
        aria-label={floating ? title : undefined}
        aria-labelledby={!floating && title ? titleId : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={floating ? 'np-hoja' : 'np-hoja np-modal-panel'}
        data-full={full ? '' : undefined}
        style={style}
      >
        {floating ? null : (
          <div className="np-hoja-head" onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}>
            <span className="np-hoja-asa" aria-hidden="true" />
            <div className="np-hoja-cabecera">
              {title ? (
                <h3 id={titleId} className="np-hoja-titulo">
                  {title}
                </h3>
              ) : null}
              <IconButton icon="close" label="Cerrar" className="np-hoja-cerrar" onClick={onClose} />
            </div>
          </div>
        )}
        <div className="np-hoja-body">{children}</div>
        {footer ? (
          <div className="np-hoja-pie" data-np-foot="">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Mientras está abierta: foco dentro, Esc cierra, scroll de fondo parado. Devuelve el "deshacer". */
function trapFocus(panel: HTMLElement, close: () => void, previous: HTMLElement | null): () => void {
  const id = Symbol('modal');
  openModals = [...openModals, id];
  const isTop = () => openModals[openModals.length - 1] === id;
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
