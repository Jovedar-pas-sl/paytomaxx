'use client';

import { useEffect, useState } from 'react';
import { haptic } from '@nightpay/ui';
import { PIN_ENTER, keypadDigits } from '@/lib/pin-pad';
import { formatEur } from '@/lib/money';
import { pinFootnote, tipLine } from '@/lib/cobro-view';
import { pinTipButtons, pinTipCents, pinTipInitial, type PinTipChoice, type PinTipSetup } from '@/lib/pin-tip';
import { useVenueNight } from '@/lib/venue-methods';
import { Chip } from './ScreenHeader';
import { IconDel, IconHand } from './icons';
import styles from './cobrar.module.css';

const PIN_LENGTH = 4;

interface Props {
  /** Las secciones del cobro (el punto del chip: la primera). */
  colors: ReadonlyArray<{ color: string; weight: number }>;
  /** «Servicios · Lola». */
  chip: string;
  amountCents: number;
  /** «1 h · saldo K7Q-4M2». */
  detail: string;
  /**
   * B1: la propina la elige aquí el cliente, sin nada marcado (null: el cobro
   * no admite propinas). `amountCents` lleva la de un cobro de antes, si la hay.
   */
  tipSetup?: PinTipSetup | null;
  /** Por qué pide el PIN (si no es el tope de siempre): «Ya lleva el tope sin PIN de esta noche…». */
  reason?: string | null;
  /** Con la propina que eligió (null: sin propinas). Devuelve un mensaje si no ha valido (PIN malo…) o null si ya está. */
  onPin: (pin: string, tipCents: number | null) => Promise<string | null>;
  onCancel: () => void;
}

/** Lo que se dice si «Otra» no vale aún (y el PIN no se acepta hasta arreglarlo). */
function tipProblem(error: 'empty' | 'max' | null, maxCents: number): string | null {
  if (error === 'empty') return 'Pon cuánto de propina o elige otra opción · Enter the tip or choose another option';
  if (error === 'max') return `La propina, como mucho ${formatEur(Math.floor(maxCents / 100) * 100, { compact: true })}`;
  return null;
}

/**
 * El PIN (maqueta 3.2), solo cuando el API lo pide: teclado fijo del 1 al 9
 * como en un cajero (a oscuras el dedo encuentra el número sin buscarlo),
 * teclas de 74 px y nada más en pantalla; o con las cifras cambiando de sitio
 * si el local lo pide (Ajustes → Noche). Se envía solo al poner la cuarta
 * cifra. Encima, la propina: la elige el cliente (B1), sin nada marcado.
 */
export function PinScreen({ colors, chip, amountCents, detail, tipSetup = null, reason, onPin, onCancel }: Props) {
  const night = useVenueNight();
  const layout = night.pinKeypad;
  const [keys, setKeys] = useState<string[]>(() => keypadDigits(layout));
  useEffect(() => setKeys(keypadDigits(layout)), [layout]);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<PinTipChoice>(() => (tipSetup ? pinTipInitial(tipSetup) : { kind: 'none' }));
  const chosen = tipSetup ? pinTipCents(choice, tipSetup) : null;
  const tipCents = chosen && !chosen.error ? chosen.cents : 0;
  const baseCents = tipSetup ? tipSetup.baseCents : amountCents;
  const totalCents = baseCents + tipCents;
  // «33 € + 5 € de propina», a la vista del cliente (la que eligió él).
  const tip = tipLine({ baseCents, tipCents, totalCents });

  async function complete(value: string) {
    setBusy(true);
    try {
      const problem = await onPin(value, tipSetup ? tipCents : null);
      setPin('');
      setError(problem);
      setKeys(keypadDigits(layout));
    } catch (err) {
      setPin('');
      setError((err as Error).message);
      setKeys(keypadDigits(layout));
    } finally {
      setBusy(false);
    }
  }

  function press(digit: string) {
    if (busy || pin.length >= PIN_LENGTH) return;
    // «Otra» sin importe (o de más): primero eso, y el PIN no se envía con una propina a medias.
    const tipError = tipSetup && chosen ? tipProblem(chosen.error, tipSetup.maxCents) : null;
    if (tipError) {
      setError(tipError);
      return;
    }
    haptic();
    const next = pin + digit;
    setPin(next);
    setError(null);
    if (next.length === PIN_LENGTH) void complete(next);
  }

  function pick(next: PinTipChoice) {
    setChoice(next);
    setError(null);
  }

  const shuffled = layout === 'shuffled';
  return (
    <div className={styles.screen}>
      <div className={styles.body} style={{ gap: '0.875rem' }}>
        <div className={styles.pinHead}>
          <Chip color={colors[0]?.color ?? 'var(--np-sec-otros)'}>{chip}</Chip>
          <span className={styles.num} aria-live="polite">
            {formatEur(totalCents, { compact: true })}
          </span>
          {tip ? (
            <p>
              {tip.base} + {tip.tip} de propina
            </p>
          ) : null}
          <p>{detail}</p>
        </div>
        {tipSetup ? <PinTip setup={tipSetup} choice={choice} onPick={pick} disabled={busy} /> : null}
        <div className={styles.pinQ}>
          <b>
            {PIN_ENTER.es} <span lang="en" className={styles.en}>· {PIN_ENTER.en}</span>
          </b>
          <span className={styles.dots} role="status" aria-label={`${pin.length} de ${PIN_LENGTH} cifras`}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => (
              <i key={i} className={i < pin.length ? styles.full : undefined} />
            ))}
          </span>
        </div>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : reason ? (
          <p className={styles.cover}>{reason}</p>
        ) : null}
        <div className={`${styles.pad}${shuffled ? ` ${styles.padSmall}` : ''}`}>
          {keys.slice(0, 9).map((d) => (
            <button key={d} type="button" className={styles.key} onClick={() => press(d)} disabled={busy}>
              {d}
            </button>
          ))}
          <button type="button" className={`${styles.key} ${styles.keyText}`} onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className={styles.key} onClick={() => press(keys[9]!)} disabled={busy}>
            {keys[9]}
          </button>
          <button
            type="button"
            className={styles.key}
            aria-label="Borrar"
            onClick={() => setPin((p) => p.slice(0, -1))}
            disabled={busy || pin.length === 0}
          >
            <IconDel />
          </button>
        </div>
        <p className={styles.cover}>
          <IconHand />
          {shuffled ? 'Tápalo con la mano. Las cifras cambian de sitio cada vez.' : pinFootnote(night)}
        </p>
      </div>
    </div>
  );
}

/**
 * La propina, para el cliente (con su línea en inglés): «Sin propina», las
 * sugeridas del local y «Otra» (euros enteros, hasta el máximo). Nada marcado
 * al abrir; sin elegir, no hay propina.
 */
function PinTip({
  setup,
  choice,
  onPick,
  disabled,
}: {
  setup: PinTipSetup;
  choice: PinTipChoice;
  onPick: (next: PinTipChoice) => void;
  disabled: boolean;
}) {
  const on = (c: number) => choice.kind === 'button' && choice.cents === c;
  const canOther = setup.maxCents >= 100;
  const percentOf = (c: number) => setup.presets.find((p) => p.cents === c)?.percent ?? null;
  return (
    <div className={styles.pinTip}>
      <p className={styles.pinTipQ} id="pin-tip-q">
        ¿Propina? <span lang="en" className={styles.en}>· Tip?</span>
      </p>
      <div className={styles.pinTipRow} role="radiogroup" aria-labelledby="pin-tip-q">
        <button
          type="button"
          role="radio"
          aria-checked={on(0)}
          className={`${styles.pinTipOpt} ${styles.pinTipWord}${on(0) ? ` ${styles.pinTipOn}` : ''}`}
          onClick={() => onPick({ kind: 'button', cents: 0 })}
          disabled={disabled}
        >
          Sin propina
          <small lang="en">No tip</small>
        </button>
        {pinTipButtons(setup).map((c) => {
          const percent = percentOf(c);
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on(c)}
              className={`${styles.pinTipOpt}${on(c) ? ` ${styles.pinTipOn}` : ''}`}
              onClick={() => onPick({ kind: 'button', cents: c })}
              disabled={disabled}
            >
              +{formatEur(c, { compact: true })}
              {percent ? <small>{percent} %</small> : null}
            </button>
          );
        })}
        {canOther ? (
          <button
            type="button"
            role="radio"
            aria-checked={choice.kind === 'other'}
            className={`${styles.pinTipOpt} ${styles.pinTipWord}${choice.kind === 'other' ? ` ${styles.pinTipOn}` : ''}`}
            onClick={() => onPick({ kind: 'other', text: choice.kind === 'other' ? choice.text : '' })}
            disabled={disabled}
          >
            Otra
            <small lang="en">Other</small>
          </button>
        ) : null}
      </div>
      {choice.kind === 'other' ? (
        <label className={styles.pinTipOther}>
          <span>
            ¿Cuánto? <span lang="en" className={styles.en}>· How much?</span>
          </span>
          <span className={styles.pinTipEur}>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="off"
              autoFocus
              value={choice.text}
              onChange={(e) => onPick({ kind: 'other', text: e.target.value })}
              disabled={disabled}
              aria-describedby="pin-tip-max"
            />
            €
          </span>
          <small id="pin-tip-max">Hasta {formatEur(Math.floor(setup.maxCents / 100) * 100, { compact: true })}</small>
        </label>
      ) : null}
    </div>
  );
}
