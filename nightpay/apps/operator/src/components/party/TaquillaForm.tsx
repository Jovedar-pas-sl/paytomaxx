'use client';

import { useState } from 'react';
import { Icon } from '@nightpay/ui';
import { SkelTiles } from '../loading-shapes';
import { formatEur } from '@/lib/money';
import {
  CARD_INFO,
  PARTY_QUICK_AMOUNTS,
  changeCents,
  givenOptions,
  initialMethod,
  isQuickAmount,
  keepGiven,
  shortEur,
  taquillaCta,
  type PulseraCard,
} from '@/lib/party-taquilla';
import { methodArmed, type MethodButton } from '@/lib/reception-desk';
import type { PayMethod, TopUpCharge } from '@/lib/reception';
import s from './party.module.css';

interface Props {
  /** La pulsera leída (o el saldo). */
  card: PulseraCard;
  /** «Cargada hace 2 min: 50 € en efectivo (Sergio)» (A4): para no cargar dos veces. */
  recent: string | null;
  /** El importe marcado al abrir (el de la maqueta, o el tecleado en «Otro»). */
  initialAmount: number;
  /** Efectivo y tarjeta para ese importe (los de la recepción: lo que puede quien carga y el tope del efectivo). */
  buttonsFor: (amountCents: number) => MethodButton[];
  /** Lo que paga el cliente: la carga más la comisión del servicio, si el local la tiene. */
  chargeFor: (amountCents: number) => TopUpCharge;
  /** Las opciones de la recepción aún no han llegado. */
  loading: boolean;
  /** La nota del PIN (null: ya lo tiene). */
  pinNote: string | null;
  busy: boolean;
  error: string | null;
  /** «Otra»: leer otra pulsera. */
  onAnother: () => void;
  /** «Otro»: el teclado del importe. */
  onOther: () => void;
  /** Encargado o dueño ante una pulsera sin PIN: que lo elija sin cargar nada. */
  onPin?: () => void;
  /** Un saldo sin pulsera, por su código: darle una. */
  onGiveFicha?: () => void;
  /** El botón de abajo: cargar en efectivo o cobrar con tarjeta (el QR de siempre). */
  onSubmit: (method: PayMethod, amountCents: number, changeCents: number | null) => void;
}

/**
 * OxioParty · la taquilla (maqueta Taquilla.dc.html): la pulsera leída, el
 * importe (10, 20, 50 € u «Otro»), cómo paga (efectivo o tarjeta) y, en
 * efectivo, con qué billete paga y el cambio. El botón dice lo que hace:
 * «Cargar 20 € en efectivo» o «Cobrar 20 € con tarjeta». Lo que pasa después
 * es lo de la recepción de siempre (confirmar con la misma pulsera, el QR…).
 */
export function TaquillaForm(props: Props) {
  const { card, initialAmount, buttonsFor, chargeFor } = props;
  const [cents, setCents] = useState<number>(initialAmount);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [given, setGiven] = useState<number | null>(null);
  // Un toque en el primer medio segundo es el segundo de un doble toque en la
  // pantalla de antes («Seguir con 30 €»): no carga nada (S-1a).
  const [armedAt] = useState(() => Date.now());

  const buttons = buttonsFor(cents);
  const chosen = method && buttons.some((b) => b.method === method && b.problem === null) ? method : initialMethod(buttons);
  const charge = chargeFor(cents);
  const bill = keepGiven(given, charge.totalCents);
  const change = changeCents(charge.totalCents, bill);
  const problems = [...new Set(buttons.filter((b) => b.problem).map((b) => b.problem as string))];
  const blocked = !chosen || (buttons.find((b) => b.method === chosen)?.problem ?? null) !== null;

  return (
    <div className={s.taquilla}>
      <div className={`${s.card} ${s.pulsera}`} data-tour="recep-ficha">
        <span className={s.pulseraIcon} aria-hidden="true">
          <Icon name="nfc" />
        </span>
        <div className={s.pulseraText}>
          <p className={s.pulseraNo}>
            <span>{card.title}</span>
            {card.isNew ? <span className={s.badge}>Nueva</span> : null}
          </p>
          <p className={s.pulseraSub}>{card.detail}</p>
          {props.recent ? <p className={s.pulseraSub}>{props.recent}</p> : null}
        </div>
        <button type="button" className={s.otra} onClick={props.onAnother} aria-label="Leer otra pulsera">
          Otra
        </button>
      </div>

      {props.onPin || props.onGiveFicha ? (
        <p className={s.fee}>
          {props.onPin ? (
            <button type="button" className={s.link} onClick={props.onPin}>
              Que elija su PIN
            </button>
          ) : null}
          {props.onPin && props.onGiveFicha ? ' · ' : null}
          {props.onGiveFicha ? (
            <button type="button" className={s.link} onClick={props.onGiveFicha}>
              Darle una pulsera
            </button>
          ) : null}
        </p>
      ) : null}

      <section className={s.card} aria-label="Importe" data-tour="recep-importes">
        <div className={s.amountHead}>
          <p className={s.kicker}>Cargar</p>
          <p className={s.bigAmount}>{shortEur(cents)}</p>
        </div>
        <div className={s.quick} role="group" aria-label="Importe">
          {PARTY_QUICK_AMOUNTS.map((c) => (
            <button key={c} type="button" className={s.opt} aria-pressed={cents === c} onClick={() => setCents(c)}>
              {shortEur(c)}
            </button>
          ))}
          <button type="button" className={s.opt} aria-pressed={!isQuickAmount(cents)} aria-label="Otro importe" onClick={props.onOther}>
            Otro
          </button>
        </div>
        {charge.feeCents > 0 ? <p className={s.fee}>{charge.text}</p> : null}
      </section>

      {buttons.length > 0 ? (
        <div className={s.methods} role="group" aria-label="Forma de pago" data-tour="recep-metodos">
          {buttons.map((b) => (
            <button
              key={b.method}
              type="button"
              className={s.segBtn}
              aria-pressed={chosen === b.method}
              disabled={b.problem !== null}
              onClick={() => setMethod(b.method)}
            >
              <Icon name={b.method === 'cash' ? 'cash' : 'card'} size={20} />
              {b.method === 'cash' ? 'Efectivo' : 'Tarjeta'}
            </button>
          ))}
        </div>
      ) : props.loading ? (
        <SkelTiles count={2} height="3rem" className={s.methods} />
      ) : null}

      {chosen === 'cash' ? (
        <section className={s.card} aria-label="Cambio">
          <div className={s.givenRow}>
            <span className={s.givenLabel}>Te da</span>
            <div className={s.bills} role="group" aria-label="Billete recibido">
              {givenOptions(charge.totalCents).map((g) => (
                <button key={g.cents} type="button" className={s.opt} aria-pressed={bill === g.cents} disabled={!g.enough} onClick={() => setGiven(g.cents)}>
                  {shortEur(g.cents)}
                </button>
              ))}
            </div>
          </div>
          <div className={s.divider} />
          <div className={s.changeRow}>
            <span className={s.givenLabel}>Cambio</span>
            <span className={s.change} data-none={change === null ? 'true' : undefined} aria-live="polite">
              {change === null ? '—' : formatEur(change)}
            </span>
          </div>
        </section>
      ) : chosen === 'card' ? (
        <div className={`${s.card} ${s.info}`}>
          <Icon name="info" size={20} />
          <p>{CARD_INFO}</p>
        </div>
      ) : null}

      {problems.map((p) => (
        <p key={p} className={s.fee}>
          {p}
        </p>
      ))}
      {props.pinNote ? <p className={s.fee}>{props.pinNote}</p> : null}

      <div className={s.grow} />
      {props.error ? (
        <p role="alert" className={s.error}>
          {props.error}
        </p>
      ) : null}
      <button
        type="button"
        className={s.cobrar}
        disabled={blocked || props.busy || props.loading}
        aria-busy={props.busy || undefined}
        onClick={() => {
          if (!chosen || !methodArmed(armedAt, Date.now())) return;
          props.onSubmit(chosen, cents, chosen === 'cash' ? change : null);
        }}
      >
        {props.busy ? 'Un momento…' : taquillaCta(chosen ?? 'cash', cents)}
      </button>
    </div>
  );
}
