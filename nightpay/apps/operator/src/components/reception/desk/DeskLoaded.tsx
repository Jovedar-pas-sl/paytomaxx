'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cashHow, DoneMark, OutcomeHowCard, PrintButton, ScreenHelp, SectionChip, usePrintTicket, type Ticket } from '@nightpay/ui';
import { playOutcomeSound } from '@/lib/alert-sound';
import { isParty, pulseraText } from '@/lib/edition';
import { formatEur } from '@/lib/money';
import { TOURS } from '@/lib/tours';
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
  money: { icon: 'cash' | 'card' | 'bitcoin'; label: string; amount: string; tail: string } | null;
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
  /**
   * Quien cobra, si el efectivo entró hoy en la caja: el bloque del dinero pasa a
   * ser la tarjeta de «cómo se pagó» (En efectivo · Mételo en la caja · Cobró…).
   */
  cashBy?: string | null;
  /** CARGADO: el ticket de la carga que sale con «Imprimir ticket» (papel de 58 mm). */
  print?: Ticket | null;
}

/** «En efectivo · Mételo en la caja»; con comisión, también cuánto va a la caja (no es el mismo importe). */
function cashCard(cashAmount: string, loadedAmount: string, by: string, at: Date) {
  const how = cashHow({ who: by, at });
  return cashAmount === loadedAmount ? how : { ...how, rows: [{ label: 'A la caja', value: cashAmount, num: true }, ...how.rows] };
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
  cashBy = null,
  print = null,
}: Props) {
  const printer = usePrintTicket();
  // La hora a la que salió la pantalla (no cambia al repintar).
  const [shownAt] = useState(() => new Date());
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
      {/* s.body: la pantalla del resultado con más cosas, más junta (loaded.module.css). */}
      <div className={`np-outcome-body ${s.body}`}>
        <div className="np-outcome-top">
          <SectionChip section="VENUE_ENTRY">{isParty() ? 'Taquilla' : 'Recepción'}</SectionChip>
          {reference ? <span className="np-outcome-ref">{reference}</span> : null}
          {/* CARGADO es un resultado: el tutorial no sale solo, solo con el «?». */}
          <ScreenHelp {...TOURS.recepcionCargado} ready={false} />
        </div>
        {aviso ? <CounterAviso text={aviso} className={s.resAviso} /> : null}
        {/* La marca y la palabra: una debajo de otra; en una pantalla baja, en la misma fila. */}
        <div className={s.headline}>
          <DoneMark />
          <h2 id={titleId} className="np-outcome-title" data-tour="recep-cargado" style={{ '--np-fit': Math.max(4, word.length * 0.74).toFixed(2) } as CSSProperties}>
            {word}
          </h2>
        </div>
        <p className="np-outcome-amount" style={{ '--np-fit': Math.max(4, amount.length * 0.58).toFixed(2) } as CSSProperties}>
          {amount}
        </p>
        {money && cashBy && money.icon === 'cash' ? (
          <OutcomeHowCard how={cashCard(money.amount, amount, cashBy, shownAt)} />
        ) : money ? (
          <p className={s.resLeft}>
            <Icon name={money.icon} />
            <span>
              {money.label} <b>{money.amount}</b> {money.tail}
            </span>
          </p>
        ) : null}
        <p className={s.resMeta}>{meta}</p>
        {ids ? <LoadedIdsView ids={ids} /> : null}
        {help ? <p className={s.resHelp}>{help}</p> : null}
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
        <div className="np-outcome-actions" data-tour="recep-siguiente">
          <button ref={primaryRef} type="button" className="np-outcome-btn" data-variant="primary" onClick={primary.onClick}>
            {primary.label}
          </button>
          {secondary ? (
            <button type="button" className="np-outcome-btn" data-variant="secondary" onClick={secondary.onClick}>
              {secondary.label}
            </button>
          ) : null}
          {print ? <PrintButton label="Imprimir ticket" onClick={() => printer.print(print)} /> : null}
        </div>
        {tertiary}
      </div>
      {printer.ticketNode}
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
      <DoneMark className={s.bandTick} />
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
        <div className={s.ids} data-tour="recep-ids">
          {ids.ficha ? (
            <div className={s.idCell}>
              <span className={s.idKey}>{pulseraText('Ficha')}</span>
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
