'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SectionChip } from '@nightpay/ui';
import { playOutcomeSound } from '@/lib/alert-sound';
import { formatEur } from '@/lib/money';
import { Icon } from './desk-parts';
import s from './loaded.module.css';

interface Action {
  label: string;
  onClick: () => void;
}

interface Props {
  /** «CARGADO» (4.4) o «DEVUELTO» (la salida). */
  word: string;
  amountCents: number;
  /** La referencia de arriba: el código del saldo (P9H-2XT). */
  reference: string | null;
  /** El bloque de debajo del importe: «Efectivo: 50 € a la caja». */
  money: { icon: 'cash' | 'card'; label: string; amount: string; tail: string } | null;
  /** «Dale el NFC · ficha nº 0522». */
  meta: string;
  /** Algo que no salió (el NFC no se pudo dar…): el dinero sí está. */
  warn?: string | null;
  primary: Action;
  secondary?: Action | null;
  /** Sin sonido ni vibración (se vuelve a esta pantalla, p. ej. tras el PIN). */
  quiet?: boolean;
  /** Debajo: el QR de «Activar Face ID en su móvil». */
  extra?: ReactNode;
}

/**
 * 4.4: el mismo verde que PAGADO (el dinero ya está dentro), con lo que hace
 * recepción con el efectivo, destacado en su bloque, y que entregue el NFC.
 * Suena y vibra como un cobro pagado (dos vibraciones cortas). Usa la
 * pantalla del resultado de @nightpay/ui (.np-outcome) sin su franja de la
 * hora (la ve solo quien cobra) ni tira de color arriba (Grafito: plano).
 */
export function DeskLoaded({ word, amountCents, reference, money, meta, warn, primary, secondary, quiet = false, extra }: Props) {
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const amount = formatEur(amountCents, { compact: true });
  // El anuncio va a una región que ya existe (si nace con el texto, muchos lectores no lo leen).
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (!quiet) playOutcomeSound('paid');
    primaryRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setAnnounce(`${word}. ${amount}. ${meta}`), 150);
    return () => clearTimeout(timer);
    // Una vez, al salir la pantalla.
  }, []);
  return (
    <section className="np-outcome" data-kind="paid" aria-labelledby={titleId}>
      <div className="np-outcome-body">
        <div className="np-outcome-top">
          <SectionChip section="VENUE_ENTRY">Recepción</SectionChip>
          {reference ? <span className="np-outcome-ref">{reference}</span> : null}
        </div>
        <span className="np-outcome-ring" aria-hidden="true">
          <svg className="np-outcome-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h2 id={titleId} className="np-outcome-title" style={{ '--np-fit': Math.max(4, word.length * 0.74).toFixed(2) } as CSSProperties}>
          {word}
        </h2>
        <p className="np-outcome-amount" style={{ '--np-fit': Math.max(4, amount.length * 0.58).toFixed(2) } as CSSProperties}>
          {amount}
        </p>
        {money ? (
          <p className={s.resLeft}>
            <Icon name={money.icon} />
            <span>
              {money.label} <b>{money.amount}</b> {money.tail}
            </span>
          </p>
        ) : null}
        <p className={s.resMeta}>{meta}</p>
        {warn ? (
          <p role="alert" className={s.resWarn}>
            {warn}
          </p>
        ) : null}
        {extra}
      </div>
      <div className={s.resFoot}>
        <div className="np-outcome-actions">
          <button ref={primaryRef} type="button" className="np-outcome-btn" data-variant="primary" onClick={primary.onClick}>
            {primary.label}
          </button>
          {secondary ? (
            <button type="button" className="np-outcome-btn" data-variant="secondary" onClick={secondary.onClick}>
              {secondary.label}
            </button>
          ) : null}
        </div>
      </div>
      <p role="status" aria-live="polite" className="np-sr-only">
        {announce}
      </p>
    </section>
  );
}
