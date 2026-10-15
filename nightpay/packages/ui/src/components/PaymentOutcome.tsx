'use client';

import { forwardRef, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { amountParts } from '../format';
import { useNow } from '../hooks';
import { agoLabel } from '../lib/countdown';
import { clockTime, OUTCOME_TITLE, type OutcomeKind } from '../lib/outcome';

export interface OutcomeAction {
  label: string;
  onClick: () => void;
  /** Esperando al servidor (p. ej. creando otro QR): el botón no se puede volver a pulsar. */
  loading?: boolean;
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
 * una sala oscura: PAGADO en lima, RECHAZADO en rojo, CADUCADO en ámbar, con
 * la palabra y el importe enormes (nunca solo el color). El «hace 0:12» y la
 * franja con la hora que se mueve delatan una captura de pantalla vieja; con
 * «reducir movimiento», la franja solo se funde.
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
        <OutcomeIcon kind={kind} />
        <h2 id={titleId} className="np-outcome-title" style={fit(title, 0.9)}>
          {title}
        </h2>
        <p className="np-outcome-amount" style={fit(amount, 0.82)}>
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

/** Tamaño de letra que cabe en el ancho de la pantalla (Unbounded es muy ancha). */
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
      disabled={action.loading}
      aria-busy={action.loading || undefined}
    >
      {action.loading ? 'Un momento…' : action.label}
    </button>
  );
});

function OutcomeIcon({ kind }: { kind: OutcomeKind }) {
  return (
    <svg
      className="np-outcome-icon"
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="4.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="24" cy="24" r="20" />
      {kind === 'paid' ? <path d="M14 24.5l7 7 13-14" /> : null}
      {kind === 'failed' ? <path d="M16.5 16.5l15 15M31.5 16.5l-15 15" /> : null}
      {kind === 'expired' ? <path d="M24 13v11l7 5" /> : null}
    </svg>
  );
}
