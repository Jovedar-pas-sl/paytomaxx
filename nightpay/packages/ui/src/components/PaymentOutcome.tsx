'use client';

import { forwardRef, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatMoney } from '@nightpay/contracts';
import { useNow } from '../hooks';
import { agoLabel } from '../lib/countdown';
import { clockTime, OUTCOME_TITLE, type OutcomeKind } from '../lib/outcome';
import { sectionsChipText, sectionVar } from '../lib/sections';
import { SectionChip } from './SectionChip';

export interface OutcomeAction {
  label: string;
  onClick: () => void;
  /** Esperando al servidor (p. ej. creando otro QR): dice «Un momento…» y no se puede pulsar. */
  loading?: boolean;
  /** No se puede pulsar ahora (p. ej. mientras el otro botón espera al servidor). */
  disabled?: boolean;
  /** Un icono delante del texto (p. ej. el QR de «Cobrar 50 € con QR»). */
  icon?: ReactNode;
}

/**
 * «Cómo se pagó», la tarjeta bajo el importe del PAGADO (Grafito 3): ficha,
 * efectivo o tarjeta. Solo lleva datos que el API ya tiene; lo que no existe
 * no se pasa (y no se enseña).
 */
export interface OutcomeHow {
  kind: 'ficha' | 'cash' | 'card';
  /** «Con ficha nº 1013», «En efectivo», «Con tarjeta». */
  title: string;
  /** «Código del saldo K7Q-•••», «Mételo en la caja», «Apple Pay o Google Pay». */
  sub?: string | null;
  /** Las filas de debajo: «Le quedan 26 €», «Cobró Carlos · 01:22»… (`num`: cifra en Manrope 700). */
  rows: ReadonlyArray<{ label: string; value: string; num?: boolean }>;
}

export interface PaymentOutcomeProps {
  kind: OutcomeKind;
  amountCents: number;
  currency?: string;
  /** Cuándo se supo el resultado (ms). Por defecto, cuando sale la pantalla. */
  sinceMs?: number;
  /** Una frase bajo el importe. Por defecto la de cada resultado (pagado: ninguna). */
  message?: string;
  /** Justo bajo el importe, antes del código: «33 € + 2 € de propina». */
  summary?: ReactNode;
  /** Debajo del código: «le quedan 40 €», quién / qué / cómo… */
  detail?: ReactNode;
  /** Pagado: la tarjeta de cómo se pagó (ficha, efectivo o tarjeta), bajo el importe. */
  how?: OutcomeHow | null;
  /**
   * Código corto que también ve el cliente en su móvil (solo pagado): grande,
   * para compararlo a un metro. La referencia («C-0023») va pequeña arriba.
   */
  code?: string | null;
  codeHint?: string;
  /** Sección del cobro (VENUE_BAR, CHICA_SERVICE… o copas, servicios…): su chip arriba. */
  section?: string | null;
  /** Varias secciones («Copas + Comida»): un chip partido con sus colores (gana a `section`). */
  sections?: readonly string[] | null;
  /**
   * El nombre de cada sección en el chip: el que le puso el local (Ajustes →
   * Secciones). Sin él, el de fábrica.
   */
  sectionLabel?: (code: string) => string;
  /** «20 €» en vez de «20,00 €» cuando no hay céntimos (como en la pantalla de cobrar). */
  compactAmount?: boolean;
  /** Referencia del cobro («C-4821»): pequeña arriba, junto a la sección. */
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

/** Repeticiones de la franja (dos mitades iguales para que el bucle no salte). */
const BAND_ITEMS = 8;

/**
 * El resultado de un cobro a pantalla completa, para verlo desde un metro en
 * una sala oscura (Grafito, plano): PAGADO en verde profundo con su ✓ que se
 * dibuja, NO PAGADO en rojo con una cruz, CADUCADO en ámbar, con la palabra y
 * el importe grandes (nunca solo el color). El «hace 0:12» y la marquesina
 * con la hora que se mueve delatan una captura de pantalla vieja; con
 * «reducir movimiento», la marquesina solo se funde. Los botones, siempre a
 * la vista (pegados abajo).
 */
export function PaymentOutcome({
  kind,
  amountCents,
  currency = 'EUR',
  sinceMs,
  message = DEFAULT_MESSAGE[kind],
  summary,
  detail,
  how,
  code,
  codeHint,
  section,
  sections,
  sectionLabel,
  compactAmount = false,
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
  // El formato de toda la app: «35 €» (compacto) o «35,00 €»; miles con punto.
  const amount = formatMoney(amountCents, { compact: compactAmount, currency });
  const many = sections && sections.length > 1 ? sections.slice(0, 2) : null;

  // El anuncio va a una región que ya existe: si nace con el texto, muchos
  // lectores de pantalla no lo leen.
  // El lector dice la palabra de la pantalla («No pagado», no «Rechazado»: S-9).
  const spoken = [title, amount, message, code ? `Código ${code.split('').join(' ')}` : null]
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
        {section || many || reference ? (
          <div className="np-outcome-top">
            {many ? (
              // Un punto por sección y sus nombres (el color nunca va solo), sin chip partido.
              <span className="np-chip" style={{ '--np-c': sectionVar(many[0]) } as CSSProperties}>
                <i className="np-chip-dot" style={{ background: sectionVar(many[1]) }} aria-hidden="true" />
                {sectionsChipText(many, sectionLabel)}
              </span>
            ) : section ? (
              <SectionChip section={section}>{sectionLabel?.(section)}</SectionChip>
            ) : null}
            {reference ? <span className="np-outcome-ref">{reference}</span> : null}
          </div>
        ) : null}
        <OutcomeIcon kind={kind} />
        <h2 id={titleId} className="np-outcome-title np-outcome-word" style={{ '--np-fit-word': Math.max(4, title.length * 0.74).toFixed(2) } as CSSProperties}>
          {title}
        </h2>
        <p className="np-outcome-amount np-outcome-amount-sub" style={fit(amount, 0.58)}>
          {amount}
        </p>
        {how ? <OutcomeHowCard how={how} /> : null}
        {message ? <p className="np-outcome-message">{message}</p> : null}
        {summary ? <div className="np-outcome-detail">{summary}</div> : null}
        {code ? (
          <div className="np-outcome-code">
            <span className="np-outcome-code-label">Código</span>
            <span className="np-outcome-code-value">{code}</span>
            {codeHint ? <span className="np-outcome-code-hint">{codeHint}</span> : null}
          </div>
        ) : null}
        {detail ? <div className="np-outcome-detail">{detail}</div> : null}
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

const HOW_ICON: Record<OutcomeHow['kind'], ReactNode> = {
  ficha: <path d="M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18M9 9.5c1.6-1.3 4.4-1.3 6 0M7.5 7.5c2.5-2.2 6.5-2.2 9 0M10.5 11.5c.8-.6 2.2-.6 3 0" />,
  cash: <path d="M3 7h18v10H3zM7 7v10M17 7v10M12 9.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5" />,
  card: <path d="M3 6h18v12H3zM3 10h18M7 15h4" />,
};

/** La tarjeta de cómo se pagó: el icono de su color, el título y sus filas. */
export function OutcomeHowCard({ how }: { how: OutcomeHow }) {
  return (
    <div className="np-outcome-how" data-how={how.kind}>
      <div className="np-outcome-how-head">
        <span className="np-outcome-how-icon" data-kind={how.kind} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {HOW_ICON[how.kind]}
          </svg>
        </span>
        <div className="np-outcome-how-text">
          <span className="np-outcome-how-title">{how.title}</span>
          {how.sub ? <span className="np-outcome-how-sub">{how.sub}</span> : null}
        </div>
      </div>
      {how.rows.map((row) => (
        <div key={row.label} className="np-outcome-how-row">
          <span className="np-outcome-how-label">{row.label}</span>
          <span className="np-outcome-how-value" data-num={row.num ? '' : undefined}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tamaño de letra que cabe en el ancho de la pantalla (Manrope 600 proporcional: ~0,55 em por cifra). */
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
      {action.loading ? (
        'Un momento…'
      ) : action.icon ? (
        <span className="np-outcome-btn-in">
          {action.icon}
          {action.label}
        </span>
      ) : (
        action.label
      )}
    </button>
  );
});

/** La marca con el icono, sin halo: ✓ en lima (pagado), ✗ (rechazado) o un reloj (caducado). */
function OutcomeIcon({ kind }: { kind: OutcomeKind }) {
  if (kind === 'paid') {
    // Grafito 3: aro verde (380 ms) y palo crema (260 ms) que se dibujan; con «reducir movimiento», ya dibujados.
    return (
      <span className="np-outcome-ring" aria-hidden="true">
        <svg className="np-check" viewBox="0 0 104 104" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle className="np-check-ring" cx="52" cy="52" r="48" strokeWidth="6" />
          <path className="np-check-tick" d="M31 53l14 14 28-30" strokeWidth="8" />
        </svg>
      </span>
    );
  }
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
