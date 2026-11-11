'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { haptic } from '../lib/haptic';

/** Lo que hay que mantener pulsado para confirmar (Grafito 3). */
export const HOLD_MS = 1200;
/** La vibración al confirmar. */
const DONE_BUZZ = [20, 40, 20] as const;

interface HoldButtonProps {
  /** «Mantén para cancelar el cobro». */
  children: ReactNode;
  /** Mientras se mantiene: «Sigue pulsando…». */
  holdingLabel?: ReactNode;
  /** Se mantuvo el tiempo entero. */
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
  /** Mientras se hace lo confirmado (p. ej. «Cancelando…»). */
  busyLabel?: ReactNode;
  busy?: boolean;
  ms?: number;
}

/**
 * Mantener pulsado 1,2 s para confirmar, en lugar de una ventana de «¿seguro?»
 * (solo en acciones que no mueven dinero). Un toque sin querer no hace nada.
 * También con teclado: mantener Intro o Espacio. Con «reducir movimiento» la
 * barra no se anima, pero hay que mantener igual.
 */
export function HoldButton({ children, holdingLabel = 'Sigue pulsando…', onConfirm, disabled = false, className, busyLabel, busy = false, ms = HOLD_MS }: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirm = useRef(onConfirm);
  useEffect(() => {
    confirm.current = onConfirm;
  });

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (timer.current || disabled || busy) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      haptic(DONE_BUZZ);
      confirm.current();
    }, ms);
  }, [disabled, busy, ms]);

  useEffect(() => stop, [stop]);

  const key = (down: boolean) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (down) {
      if (!e.repeat) start();
    } else stop();
  };

  return (
    <button
      type="button"
      className={['np-hold', className].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-holding={holding || undefined}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={key(true)}
      onKeyUp={key(false)}
      onBlur={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className={`np-hold-fill${holding ? ' on' : ''}`} aria-hidden="true" style={{ ['--np-hold-ms' as string]: `${ms}ms` }} />
      <span className="np-hold-text">{busy ? (busyLabel ?? children) : holding ? holdingLabel : children}</span>
    </button>
  );
}
