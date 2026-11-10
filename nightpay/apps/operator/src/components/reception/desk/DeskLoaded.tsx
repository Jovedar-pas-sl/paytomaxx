'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SectionChip } from '@nightpay/ui';
import { playOutcomeSound } from '@/lib/alert-sound';
import { formatEur } from '@/lib/money';
import { RECEPTION_HELP_SCREENS } from '@/lib/reception-help';
import { HelpAgain, HelpLine, useHelp } from '../../HelpLine';
import { CounterAviso, FichaNumber, Icon } from './desk-parts';
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
  /** La nota del PIN («Sin PIN solo paga hasta 20 €…»): una línea con su candado, como en «¿Cómo paga?». */
  note?: string | null;
  primary: Action;
  secondary?: Action | null;
  /** Sin sonido ni vibración (se vuelve a esta pantalla, p. ej. tras el PIN). */
  quiet?: boolean;
  /** Debajo: el QR de «Activar Face ID en su móvil». */
  extra?: ReactNode;
  /** CARGADO: qué hacer ahora, en orden (la línea de ayuda, que se cierra; su «?» va arriba). */
  help?: string | null;
  /** CARGADO (A1, A11): la ficha y el código en grande, qué mirar y qué fotografiar. */
  ids?: LoadedIds | null;
  /** Se acercó otra ficha (A3): solo el aviso, arriba; la pantalla no se cierra. */
  aviso?: string | null;
  /** Debajo de los botones, en pequeño: «Me he equivocado» (B4). */
  tertiary?: ReactNode;
}

/** La ficha y el código del saldo, en grande en CARGADO. */
export interface LoadedIds {
  /** El número impreso de la ficha (null: sin ficha o sin número impreso). */
  ficha: string | null;
  /** El código del saldo (K7Q-4M2; por número, tapado: entonces no se enseña). */
  code: string | null;
  /** «Mira que es la que tienes en la mano». */
  hint: string | null;
  /** «Haz una foto a tu ficha o a tu código» (para el cliente). */
  photo: string | null;
}

/**
 * 4.4: el mismo verde que PAGADO (el dinero ya está dentro), con lo que hace
 * recepción con el efectivo, destacado en su bloque, y que entregue el NFC.
 * Suena y vibra como un cobro pagado (dos vibraciones cortas). Usa la
 * pantalla del resultado de @nightpay/ui (.np-outcome) sin su franja de la
 * hora (la ve solo quien cobra) ni tira de color arriba (Grafito: plano).
 */
export function DeskLoaded({
  word,
  amountCents,
  reference,
  money,
  meta,
  warn,
  note = null,
  primary,
  secondary,
  quiet = false,
  extra,
  help = null,
  ids = null,
  aviso = null,
  tertiary = null,
}: Props) {
  const titleId = useId();
  const helpState = useHelp(RECEPTION_HELP_SCREENS.loaded);
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
      {/* s.body: la pantalla del resultado con más cosas, más junta (loaded.module.css). */}
      <div className={`np-outcome-body ${s.body}`}>
        <div className="np-outcome-top">
          <SectionChip section="VENUE_ENTRY">Recepción</SectionChip>
          {reference ? <span className="np-outcome-ref">{reference}</span> : null}
          {help ? <HelpAgain help={helpState} /> : null}
        </div>
        {aviso ? <CounterAviso text={aviso} className={s.resAviso} /> : null}
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
        {ids ? <LoadedIdsView ids={ids} /> : null}
        {help ? (
          <HelpLine help={helpState} className={s.resHelp}>
            {help}
          </HelpLine>
        ) : null}
        {warn ? (
          <p role="alert" className={s.resWarn}>
            {warn}
          </p>
        ) : null}
        {note ? (
          <p className={s.resNote}>
            <Icon name="lock" />
            <span>{note}</span>
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
        {tertiary}
      </div>
      <p role="status" aria-live="polite" className="np-sr-only">
        {announce}
      </p>
    </section>
  );
}

/**
 * B1: con la ficha por encima del tope sin PIN, el teclado del PIN sale solo
 * al cargar; encima, esta franja verde con lo que acaba de pasar (suena y
 * vibra como CARGADO) y lo que hay que hacer con el dinero y la ficha.
 */
export function LoadedBand({ word, amountCents, line, aviso = null }: { word: string; amountCents: number; line: string; aviso?: string | null }) {
  const amount = formatEur(amountCents, { compact: true });
  useEffect(() => {
    playOutcomeSound('paid');
    // Una vez, al salir.
  }, []);
  return (
    <div className={s.band} role="status">
      <span className={s.bandTick} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </span>
      <span className={s.bandText}>
        <b>
          {word} {amount}
        </b>
        <span>{line}</span>
      </span>
      {aviso ? <CounterAviso text={aviso} className={s.resAviso} /> : null}
    </div>
  );
}

/** La ficha y el código en grande, uno al lado del otro; debajo, qué mirar y la foto. */
function LoadedIdsView({ ids }: { ids: LoadedIds }) {
  return (
    <>
      {ids.ficha || ids.code ? (
        <div className={s.ids}>
          {ids.ficha ? (
            <div className={s.idCell}>
              <span className={s.idKey}>Ficha</span>
              <FichaNumber printed={ids.ficha} className={s.idFicha} />
            </div>
          ) : null}
          {ids.code ? (
            <div className={s.idCell}>
              <span className={s.idKey}>Código</span>
              <span className={s.idCode}>{ids.code}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {ids.hint ? <p className={s.idHint}>{ids.hint}</p> : null}
      {ids.photo ? (
        <p className={s.photo}>
          <Icon name="camera" />
          <span>{ids.photo}</span>
        </p>
      ) : null}
    </>
  );
}
