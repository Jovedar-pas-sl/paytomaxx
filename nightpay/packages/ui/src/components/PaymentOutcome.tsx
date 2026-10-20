'use client';

import { forwardRef, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { amountParts } from '../format';
import { useNow } from '../hooks';
import { agoLabel } from '../lib/countdown';
import { clockTime, OUTCOME_TITLE, type OutcomeKind } from '../lib/outcome';
import { SectionChip } from './SectionChip';

export interface OutcomeAction {
  label: string;
  onClick: () => void;
  /** Esperando al servidor (p. ej. creando otro QR): dice «Un momento…» y no se puede pulsar. */
  loading?: boolean;
  /** No se puede pulsar ahora (p. ej. mientras el otro botón espera al servidor). */
  disabled?: boolean;
}

export interface PaymentOutcomeProps {
  kind: OutcomeKind;
  amountCents: number;
  currency?: string;
  /** Cuándo se supo el resultado (ms). Por defecto, cuando sale la pantalla. */
  sinceMs?: number;
  /** Una frase bajo el importe. Por defecto la de cada resultado (pagado: ninguna). */
  message?: string;
  /** Debajo: el servicio, la propina, «le quedan 40 €»… */
  detail?: ReactNode;
  /** Código corto que también ve el cliente en su móvil (solo pagado). */
  code?: string | null;
  codeHint?: string;
  /** Sección del cobro (VENUE_BAR, CHICA_SERVICE… o copas, servicios…): su chip arriba. */
  section?: string | null;
  /** Referencia del cobro («C-4821»): una pill arriba, junto a la sección. */
  reference?: string | null;
  /** El botón grande: «Nuevo cobro», «Otro QR · mismo importe»… */
  primary: OutcomeAction;
  secondary?: OutcomeAction;
  error?: string | null;
}

const DEFAULT_MESSAGE: Record<OutcomeKind, string | undefined> = {
  paid: undefined,
  failed: 'El cobro no se ha completado.',
  expired: 'El cliente no pagó a tiempo.',
};

const SPOKEN_TITLE: Record<OutcomeKind, string> = {
  paid: 'Pagado',
  failed: 'Rechazado',
  expired: 'Caducado',
};

/** Repeticiones de la franja (dos mitades iguales para que el bucle no salte). */
const BAND_ITEMS = 8;

/**
 * El resultado de un cobro a pantalla completa, para verlo desde un metro en
 * una sala oscura: PAGADO en el verde de la marca con el aro lima, NO PAGADO
 * en rojo con una cruz, CADUCADO en ámbar, con la palabra y el importe
 * enormes (nunca solo el color). El «hace 0:12» y la franja con la hora que
 * se mueve delatan una captura de pantalla vieja; con «reducir movimiento»,
 * la franja solo se funde.
 */
export function PaymentOutcome({
  kind,
  amountCents,
  currency = 'EUR',
  sinceMs,
  message = DEFAULT_MESSAGE[kind],
  detail,
  code,
  codeHint,
  section,
  reference,
  primary,
  secondary,
  error,
}: PaymentOutcomeProps) {
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [shownAt] = useState(() => Date.now());
  const since = sinceMs ?? shownAt;
  const now = useNow(true);
  const title = OUTCOME_TITLE[kind];
  const amount = amountParts(amountCents, currency).text;

  // El anuncio va a una región que ya existe: si nace con el texto, muchos
  // lectores de pantalla no lo leen.
  const spoken = [SPOKEN_TITLE[kind], amount, message, code ? `Código ${code.split('').join(' ')}` : null]
    .filter(Boolean)
    .join('. ');
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAnnounce(spoken), 150);
    return () => clearTimeout(timer);
  }, [spoken]);

  // Con el teclado, Intro sigue sin buscar el botón.
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, []);

  const bandText = `${title} · ${clockTime(since)}`;

  return (
    <section className="np-outcome" data-kind={kind} aria-labelledby={titleId}>
      <div className="np-outcome-band" aria-hidden="true">
        <div className="np-outcome-band-track">
          {Array.from({ length: BAND_ITEMS * 2 }, (_, i) => (
            <span key={i}>{bandText}</span>
          ))}
        </div>
      </div>

      <div className="np-outcome-body">
        {section || reference ? (
          <div className="np-outcome-top">
            {section ? <SectionChip section={section} /> : null}
            {reference ? <span className="np-outcome-ref">{reference}</span> : null}
          </div>
        ) : null}
        <OutcomeIcon kind={kind} />
        <h2 id={titleId} className="np-outcome-title" style={fit(title, 0.74)}>
          {title}
        </h2>
        <p className="np-outcome-amount" style={fit(amount, 0.58)}>
          {amount}
        </p>
        {message ? <p className="np-outcome-message">{message}</p> : null}
        {detail ? <div className="np-outcome-detail">{detail}</div> : null}
        {code ? (
          <div className="np-outcome-code">
            <span className="np-outcome-code-label">Código</span>
            <span className="np-outcome-code-value">{code}</span>
            {codeHint ? <span className="np-outcome-code-hint">{codeHint}</span> : null}
          </div>
        ) : null}
        <p className="np-outcome-ago">{agoLabel(since, now)}</p>
        {error ? (
          <p role="alert" className="np-outcome-error">
            {error}
          </p>
        ) : null}
        <div className="np-outcome-actions">
          <OutcomeButton ref={primaryRef} action={primary} variant="primary" />
          {secondary ? <OutcomeButton action={secondary} variant="secondary" /> : null}
        </div>
      </div>

      <p role="status" aria-live="polite" aria-atomic="true" className="np-sr-only">
        {announce}
      </p>
    </section>
  );
}

/** Tamaño de letra que cabe en el ancho de la pantalla (Manrope 800: ~0,7 em por mayúscula, ~0,55 por cifra). */
function fit(text: string, emPerChar: number): CSSProperties {
  return { '--np-fit': Math.max(4, text.length * emPerChar).toFixed(2) } as CSSProperties;
}

interface OutcomeButtonProps {
  action: OutcomeAction;
  variant: 'primary' | 'secondary';
}

const OutcomeButton = forwardRef<HTMLButtonElement, OutcomeButtonProps>(function OutcomeButton(
  { action, variant },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className="np-outcome-btn"
      data-variant={variant}
      onClick={action.onClick}
      disabled={action.loading || action.disabled}
      aria-busy={action.loading || undefined}
    >
      {action.loading ? 'Un momento…' : action.label}
    </button>
  );
});

/** El aro con el icono: ✓ en lima (pagado), ✗ (rechazado) o un reloj (caducado). */
function OutcomeIcon({ kind }: { kind: OutcomeKind }) {
  return (
    <span className="np-outcome-ring" aria-hidden="true">
      <svg
        className="np-outcome-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'paid' ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : null}
        {kind === 'failed' ? <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /> : null}
        {kind === 'expired' ? (
          <>
            <circle cx="12" cy="12" r="8.5" strokeWidth="2.5" />
            <path d="M12 7.5V12l3 2" strokeWidth="2.5" />
          </>
        ) : null}
      </svg>
    </span>
  );
}
