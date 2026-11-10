'use client';

import { useEffect, useState } from 'react';
import { PIN_ENTER, keypadDigits } from '@/lib/pin-pad';
import { formatEur } from '@/lib/money';
import { pinFootnote } from '@/lib/cobro-view';
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
  /** La propina que marcó el personal («33 € + 5 € de propina»), a la vista del cliente (PS-A1). */
  tip?: { base: string; tip: string } | null;
  /** Por qué pide el PIN (si no es el tope de siempre): «Ya lleva el tope sin PIN de esta noche…». */
  reason?: string | null;
  /** Devuelve un mensaje si no ha valido (PIN malo…) o null si ya está. */
  onPin: (pin: string) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * El PIN (maqueta 3.2), solo cuando el API lo pide: teclado fijo del 1 al 9
 * como en un cajero (a oscuras el dedo encuentra el número sin buscarlo),
 * teclas de 74 px y nada más en pantalla; o con las cifras cambiando de sitio
 * si el local lo pide (Ajustes → Noche). Se envía solo al poner la cuarta cifra.
 */
export function PinScreen({ colors, chip, amountCents, detail, tip = null, reason, onPin, onCancel }: Props) {
  const night = useVenueNight();
  const layout = night.pinKeypad;
  const [keys, setKeys] = useState<string[]>(() => keypadDigits(layout));
  useEffect(() => setKeys(keypadDigits(layout)), [layout]);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function complete(value: string) {
    setBusy(true);
    try {
      const problem = await onPin(value);
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
    if ('vibrate' in navigator) navigator.vibrate(8);
    const next = pin + digit;
    setPin(next);
    setError(null);
    if (next.length === PIN_LENGTH) void complete(next);
  }

  const shuffled = layout === 'shuffled';
  return (
    <div className={styles.screen}>
      <div className={styles.body} style={{ gap: '0.875rem' }}>
        <div className={styles.pinHead}>
          <Chip color={colors[0]?.color ?? 'var(--np-sec-otros)'}>{chip}</Chip>
          <span className={styles.num}>{formatEur(amountCents, { compact: true })}</span>
          {tip ? (
            <p>
              {tip.base} + {tip.tip} de propina
            </p>
          ) : null}
          <p>{detail}</p>
        </div>
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
