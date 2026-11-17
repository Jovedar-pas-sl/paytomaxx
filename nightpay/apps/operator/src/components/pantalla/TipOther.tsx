'use client';

import { useState } from 'react';
import { formatEur } from '@/lib/money';
import { otherTipMaxText, otherTipOf } from '@/lib/pantalla-state';
import s from './pantalla.module.css';

/** Hasta 500 €: tres cifras bastan. */
const MAX_DIGITS = 3;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * «Otra» propina en la tablet: un teclado grande, en euros enteros y hasta el
 * tope (lo mismo que «Otra» en /pay y en el PIN). «Listo» la elige; «Volver»
 * deja la que había.
 */
export function TipOther({
  maxCents,
  initialCents,
  busy,
  onDone,
  onClose,
}: {
  maxCents: number;
  initialCents: number;
  busy: boolean;
  onDone: (cents: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialCents > 0 ? String(Math.floor(initialCents / 100)) : '');
  const [tried, setTried] = useState(false);
  const parsed = otherTipOf(text, maxCents);
  const problem = parsed.error === 'max' ? otherTipMaxText(maxCents) : tried && parsed.error === 'empty' ? 'Pon cuánto de propina' : null;

  const press = (digit: string) => {
    setTried(false);
    setText((t) => (t.length >= MAX_DIGITS || (t === '' && digit === '0') ? t : t + digit));
  };

  return (
    <div className={s.otherScrim} role="dialog" aria-modal="true" aria-label="Otra propina">
      <div className={s.otherPanel}>
        <p className={s.tipsTitle}>Otra propina</p>
        <p className={s.otherAmount} aria-live="polite">
          {text ? formatEur(Number.parseInt(text, 10) * 100, { compact: true }) : '0 €'}
        </p>
        <p className={problem ? s.otherError : s.tipNote}>{problem ?? otherTipMaxText(maxCents)}</p>
        <div className={s.otherKeys}>
          {KEYS.map((k) => (
            <button key={k} type="button" className={s.otherKey} onClick={() => press(k)} disabled={busy}>
              {k}
            </button>
          ))}
          <button type="button" className={s.otherKey} onClick={() => setText((t) => t.slice(0, -1))} disabled={busy} aria-label="Borrar">
            ⌫
          </button>
          <button type="button" className={s.otherKey} onClick={() => press('0')} disabled={busy}>
            0
          </button>
          <button
            type="button"
            className={`${s.otherKey} ${s.otherDone}`}
            disabled={busy}
            onClick={() => {
              setTried(true);
              if (!parsed.error) onDone(parsed.cents);
            }}
          >
            Listo
          </button>
        </div>
        <button type="button" className={s.otherBack} onClick={onClose} disabled={busy}>
          Volver
        </button>
      </div>
    </div>
  );
}
