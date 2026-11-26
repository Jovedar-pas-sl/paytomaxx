'use client';

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '@nightpay/ui';
import type { Segment } from '@/lib/money-map-view';

interface FichaSheetProps {
  title: string;
  subtitle?: string;
  /** El chip de la derecha (sección, «Saldo»…). */
  chip?: ReactNode;
  /** La franja de colores bajo la cabecera. */
  stripe?: Segment[];
  /** «‹»: cierra la ficha (o vuelve atrás dentro de ella). */
  onBack: () => void;
  backLabel?: string;
  /** Hay otra ventana encima (pagar, verificar): Esc no cierra esta. */
  covered?: boolean;
  footer?: ReactNode;
  /**
   * Ventanas encima (pagar, verificar): fuera de la hoja, que con su animación
   * y su desenfoque haría de marco a lo «position: fixed» de dentro.
   */
  overlays?: ReactNode;
  children: ReactNode;
}

/**
 * Hoja de una ficha (maquetas 9.1 y 9.2): a pantalla completa en el móvil y
 * en una columna en el escritorio, con su cabecera (‹, nombre, chip), la
 * franja de colores, el cuerpo que se desplaza y el botón de abajo. Esc o ‹
 * la cierran; el foco entra al abrir y vuelve a donde estaba al cerrar.
 */
export function FichaSheet({
  title,
  subtitle,
  chip,
  stripe,
  onBack,
  backLabel = 'Volver',
  covered = false,
  footer,
  overlays,
  children,
}: FichaSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const backRef = useRef(onBack);
  const coveredRef = useRef(covered);
  backRef.current = onBack;
  coveredRef.current = covered;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || coveredRef.current || e.isComposing) return;
      e.preventDefault();
      backRef.current();
    }
    function onFocusIn(e: FocusEvent): void {
      if (!coveredRef.current && e.target instanceof Node && !panel!.contains(e.target)) panel!.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = prevOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const segments = stripe?.filter((s) => s.cents > 0) ?? [];

  return (
    <>
    <div className="np-sheet-overlay">
      <div ref={panelRef} className="np-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="np-mm-head">
          <button type="button" className="np-mm-back" aria-label={backLabel} onClick={onBack}>
            <Icon name="chevron-left" />
          </button>
          <div className="np-mm-title">
            <h3 id={titleId}>{title}</h3>
            {subtitle ? <span>{subtitle}</span> : null}
          </div>
          {chip}
        </header>
        <Stripe segments={segments} />
        <div className="np-sheet-body">{children}</div>
        {footer ? <div className="np-sheet-foot">{footer}</div> : null}
      </div>
    </div>
    {overlays}
    </>
  );
}

/** La franja de colores de las secciones (proporcional a lo de cada una). */
export function Stripe({ segments }: { segments: Segment[] }) {
  if (segments.length === 0) return <div className="np-mm-stripe" data-empty="true" aria-hidden="true" />;
  return (
    <div className="np-mm-stripe" aria-hidden="true">
      {segments.map((s) => (
        <i key={s.key} style={{ '--np-c': s.color, flex: s.cents } as CSSProperties} />
      ))}
    </div>
  );
}

/** Chip del color de una sección (o a trazos: el saldo). */
export function SheetChip({ color, hold, children }: { color?: string; hold?: boolean; children: ReactNode }) {
  return (
    <span className="np-mm-chip" data-kind={hold ? 'hold' : undefined} style={color ? ({ '--np-c': color } as CSSProperties) : undefined}>
      {children}
    </span>
  );
}
