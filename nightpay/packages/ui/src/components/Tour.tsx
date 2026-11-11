'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  bubblePlacement,
  closeMarksSeen,
  hasSeenTour,
  markTourSeen,
  presentSteps,
  shouldAutoStart,
  stepCounter,
  tourMove,
  type TourCloseReason,
  type TourStep,
} from '../lib/tour';

/**
 * El tutorial de una pantalla. Oscurece la pantalla, deja iluminado el
 * elemento de cada paso (el que lleva `data-tour="…"`) y pone al lado una
 * burbuja con «1 de 4», un título, 1-2 frases y «Atrás», «Siguiente» y
 * «Saltar». El paso cuyo elemento no está en pantalla (por permisos o por
 * estado) se salta. Escape lo cierra; el foco se queda dentro de la burbuja.
 *
 *   <ScreenHelp screen="cobrar" steps={STEPS} ready={!busy} />
 *
 * Sale solo la primera vez que se abre la pantalla en este móvil u ordenador
 * (y solo cuando está libre: `ready`); después, siempre que se toque el «?».
 */

const SPOT_PAD = 6;
const GAP = 12;
const MARGIN = 16;
const BUBBLE_MAX_WIDTH = 352;
const AUTO_CHECK_MS = 1000;
const AUTO_DELAY_MS = 600;

/** El elemento del paso que se ve ahora: con tamaño y no escondido. */
export function findTourTarget(target: string, root: ParentNode = document): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`);
  for (const el of Array.from(all)) {
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return el;
  }
  return null;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Box {
  spot: { top: number; left: number; width: number; height: number };
  bubble: { top: number; left: number; width: number };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (!q) return;
    setReduced(q.matches);
    const on = () => setReduced(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

export interface TourProps {
  steps: readonly TourStep[];
  onClose: (reason: TourCloseReason) => void;
}

export function Tour({ steps, onClose }: TourProps) {
  const [present] = useState(() => presentSteps(steps, (t) => findTourTarget(t)));
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const textId = useId();
  const reduced = useReducedMotion();
  closeRef.current = onClose;

  const count = present.length;
  const current = present[index];

  // Nada que enseñar: se cierra sin dejarlo visto.
  useEffect(() => {
    if (count === 0) closeRef.current('empty');
  }, [count]);

  const place = useCallback(() => {
    const el = present[index]?.element;
    const bubble = bubbleRef.current;
    if (!el || !el.isConnected || !bubble) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spot = { top: r.top - SPOT_PAD, left: r.left - SPOT_PAD, width: r.width + SPOT_PAD * 2, height: r.height + SPOT_PAD * 2 };
    const width = Math.min(BUBBLE_MAX_WIDTH, vw - MARGIN * 2);
    const bh = bubble.offsetHeight;
    const where = bubblePlacement({ targetTop: spot.top, targetBottom: spot.top + spot.height, viewportHeight: vh, bubbleHeight: bh, gap: GAP });
    const top =
      where === 'below'
        ? spot.top + spot.height + GAP
        : where === 'above'
          ? spot.top - GAP - bh
          : where === 'bottom'
            ? vh - bh - MARGIN
            : MARGIN;
    const centered = r.left + r.width / 2 - width / 2;
    const left = Math.min(Math.max(MARGIN, centered), Math.max(MARGIN, vw - width - MARGIN));
    setBox({ spot, bubble: { top: Math.max(MARGIN / 2, top), left, width } });
  }, [present, index]);

  // Al cambiar de paso: el elemento a la vista, la burbuja a su lado y el foco dentro.
  useLayoutEffect(() => {
    const el = current?.element;
    if (!el) return;
    if (!el.isConnected) {
      // El elemento se fue (cambió el estado de la pantalla): ese paso se salta.
      const move = tourMove(index, count, 'next');
      if (move === 'done') closeRef.current('done');
      else setIndex(move.index);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.top < MARGIN || r.bottom > window.innerHeight - MARGIN) {
      el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
    }
    place();
    bubbleRef.current?.focus({ preventScroll: true });
  }, [current, index, count, place]);

  // Cambios de tamaño o de scroll mientras está abierto.
  useEffect(() => {
    let raf = 0;
    const again = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
    };
  }, [place]);

  // Escape cierra y Tab no sale de la burbuja.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current('escape');
        return;
      }
      if (e.key !== 'Tab') {
        // Con el tutorial abierto, lo de debajo no oye el teclado (el teclado del
        // importe del TPV, Intro para cobrar…). Intro y Espacio siguen pulsando los
        // botones de la burbuja: eso es lo que hace el navegador por defecto.
        e.stopPropagation();
        return;
      }
      const bubble = bubbleRef.current;
      if (!bubble) return;
      const items = Array.from(bubble.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const lastItem = items[items.length - 1];
      if (!first || !lastItem) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!bubble.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === bubble)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        first.focus();
      }
    }
    function onFocusIn(e: FocusEvent) {
      const bubble = bubbleRef.current;
      if (bubble && e.target instanceof Node && !bubble.contains(e.target)) bubble.focus({ preventScroll: true });
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  // Al cerrar, el foco vuelve a donde estaba (el «?»).
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  if (!current) return null;
  const isLast = index === count - 1;

  function go(dir: 'next' | 'prev') {
    const move = tourMove(index, count, dir);
    if (move === 'done') onClose('done');
    else setIndex(move.index);
  }

  return createPortal(
    <div className="np-tour" data-reduced={reduced ? 'true' : undefined}>
      <div className="np-tour-block" aria-hidden="true" />
      {box ? <div className="np-tour-spot" aria-hidden="true" style={box.spot} /> : null}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
        className="np-tour-bubble"
        style={box ? { top: box.bubble.top, left: box.bubble.left, width: box.bubble.width } : { top: MARGIN, left: MARGIN, visibility: 'hidden' }}
      >
        <p className="np-tour-count">{stepCounter(index, count)}</p>
        <h2 id={titleId} className="np-tour-title">
          {current.step.title}
        </h2>
        <p id={textId} className="np-tour-text">
          {current.step.text}
        </p>
        <div className="np-tour-actions">
          <button type="button" className="np-tour-skip" onClick={() => onClose('skip')}>
            Saltar
          </button>
          {index > 0 ? (
            <button type="button" className="np-tour-btn" data-kind="ghost" onClick={() => go('prev')}>
              Atrás
            </button>
          ) : null}
          <button type="button" className="np-tour-btn" data-kind="primary" onClick={() => go('next')}>
            {isLast ? 'Entendido' : 'Siguiente'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** El «?» de la cabecera: 44×44 como mínimo. */
export function HelpButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={['np-help-btn', className].filter(Boolean).join(' ')}
      aria-label="Ayuda: cómo funciona esta pantalla"
      onClick={onClick}
    >
      ?
    </button>
  );
}

/** Tutoriales abiertos en la página (solo sale uno a la vez). */
let tourOpenCount = 0;

/**
 * ¿Hay una ventana (modal) abierta que no sea un tutorial? Una pantalla que es
 * a la vez su propia ventana (el cierre de la noche) se marca con
 * `data-tour-host` y no cuenta: su tutorial puede salir en ella.
 */
function otherDialogOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some(
    (d) => !d.closest('.np-tour') && !d.hasAttribute('data-tour-host'),
  );
}

export interface UseTour {
  open: boolean;
  /** El «?»: sale siempre. */
  show: () => void;
  /** El tutorial, listo para pintar (nada si está cerrado). */
  element: ReactNode;
}

/**
 * El estado de un tutorial: sale solo la primera vez que la pantalla está
 * libre (`ready`) y, después, con `show`. Al terminarlo o saltarlo queda visto.
 */
export function useTour({ screen, steps, ready = true, delayMs = AUTO_DELAY_MS }: { screen: string; steps: readonly TourStep[]; ready?: boolean; delayMs?: number }): UseTour {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  // Lo abrió el primer arranque y no el «?».
  const autoRef = useRef(false);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const setOpened = useCallback((next: boolean) => {
    if (openRef.current === next) return;
    openRef.current = next;
    tourOpenCount += next ? 1 : -1;
    setOpen(next);
  }, []);

  useEffect(
    () => () => {
      if (openRef.current) tourOpenCount -= 1;
      openRef.current = false;
    },
    [],
  );

  // La primera vez: cuando la pantalla se ve, está libre y no hay ninguna ventana encima.
  useEffect(() => {
    if (!ready || hasSeenTour(screen)) return;
    let timer = 0;
    const attempt = () => {
      if (hasSeenTour(screen)) return;
      const hasTargets = presentSteps(stepsRef.current, (t) => findTourTarget(t)).length > 0;
      if (hasTargets && shouldAutoStart({ seen: false, ready: true, modalOpen: otherDialogOpen(), tourOpen: tourOpenCount > 0 })) {
        autoRef.current = true;
        setOpened(true);
        return;
      }
      timer = window.setTimeout(attempt, AUTO_CHECK_MS);
    };
    timer = window.setTimeout(attempt, delayMs);
    return () => window.clearTimeout(timer);
  }, [screen, ready, delayMs, setOpened]);

  // Si la pantalla deja de estar libre con el tutorial abierto solo (llega un cobro, un PAGADO), se cierra sin dejarlo visto.
  useEffect(() => {
    if (open && !ready && autoRef.current) {
      autoRef.current = false;
      setOpened(false);
    }
  }, [open, ready, setOpened]);

  const show = useCallback(() => {
    autoRef.current = false;
    setOpened(true);
  }, [setOpened]);

  const onClose = useCallback(
    (reason: TourCloseReason) => {
      if (closeMarksSeen(reason)) markTourSeen(screen);
      autoRef.current = false;
      setOpened(false);
    },
    [screen, setOpened],
  );

  return { open, show, element: open ? <Tour steps={steps} onClose={onClose} /> : null };
}

/** El «?» y su tutorial, juntos: `<ScreenHelp screen="cobrar" steps={…} ready={…} />` en la cabecera. */
export function ScreenHelp({ screen, steps, ready = true, delayMs, className }: { screen: string; steps: readonly TourStep[]; ready?: boolean; delayMs?: number; className?: string }) {
  const tour = useTour({ screen, steps, ready, delayMs });
  return (
    <>
      <HelpButton onClick={tour.show} className={className} />
      {tour.element}
    </>
  );
}
