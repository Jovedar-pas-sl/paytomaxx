'use client';

import { useState, type CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import { WALLET_PIN_PROBLEM_TEXT, walletPinProblem } from '@nightpay/contracts';
import { shuffledDigits } from '@/lib/pin-pad';

const PIN_LENGTH = 4;

interface Props {
  /** Lo que ve el cliente arriba (p. ej. "60 € · Masaje"). */
  title: string;
  hint?: string;
  /**
   * choose: el cliente elige su PIN (dos veces, sin PIN obvios).
   * enter: lo teclea para pagar.
   */
  mode: 'choose' | 'enter';
  /** Devuelve un mensaje si no ha valido (PIN malo…) o null si ya está. */
  onPin: (pin: string) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * Teclado del PIN para el cliente, en el móvil de la chica. Las cifras cambian
 * de sitio en cada intento (quien mira dónde pulsa no saca el PIN), solo se
 * ven puntos y no es un campo de texto (el móvil no lo recuerda ni lo sugiere).
 */
export function PinPad({ title, hint, mode, onPin, onCancel }: Props) {
  const [keys, setKeys] = useState<string[]>(() => shuffledDigits());
  const [pin, setPin] = useState('');
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function restart(message: string | null, keepFirst = false): void {
    setPin('');
    if (!keepFirst) setFirst(null);
    setError(message);
    setKeys(shuffledDigits());
  }

  async function complete(value: string): Promise<void> {
    if (mode === 'choose' && first === null) {
      const problem = walletPinProblem(value);
      if (problem) return restart(WALLET_PIN_PROBLEM_TEXT[problem]);
      setFirst(value);
      return restart(null, true);
    }
    if (mode === 'choose' && first !== value) return restart('Los dos PIN no son iguales: empieza otra vez');
    setBusy(true);
    try {
      // Si la pantalla sigue aquí (no se terminó), se vuelve a empezar: con
      // las 4 cifras puestas ya no se podía teclear nada.
      restart(await onPin(value));
    } catch (err) {
      restart((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function press(digit: string): void {
    if (busy || pin.length >= PIN_LENGTH) return;
    if ('vibrate' in navigator) navigator.vibrate(8);
    const next = pin + digit;
    setPin(next);
    setError(null);
    if (next.length === PIN_LENGTH) void complete(next);
  }

  const step =
    mode === 'enter' ? 'Pon tu PIN' : first === null ? 'Elige un PIN de 4 cifras' : 'Repite el PIN';

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Para el cliente</p>
      <p style={titleStyle}>{title}</p>
      {hint ? <p style={hintStyle}>{hint}</p> : null}
      <p style={stepStyle}>{step}</p>
      <div role="status" style={dotsStyle}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} aria-hidden style={{ ...dotStyle, ...(i < pin.length ? dotFull : {}) }} />
        ))}
        <span style={srOnly}>{`${pin.length} de ${PIN_LENGTH} cifras`}</span>
      </div>
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      <div style={gridStyle}>
        {keys.slice(0, 9).map((d) => (
          <button key={d} type="button" style={keyStyle} onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <button type="button" style={{ ...keyStyle, ...sideKey }} onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="button" style={keyStyle} onClick={() => press(keys[9]!)} disabled={busy}>
          {keys[9]}
        </button>
        <button
          type="button"
          aria-label="Borrar"
          style={{ ...keyStyle, ...sideKey }}
          onClick={() => setPin((p) => p.slice(0, -1))}
          disabled={busy || pin.length === 0}
        >
          ⌫
        </button>
      </div>
      <p style={hintStyle}>
        {mode === 'choose'
          ? 'Tápalo con la mano y no lo digas en voz alta. No se guarda en ningún sitio.'
          : 'Tápalo con la mano. Las cifras cambian de sitio cada vez.'}
      </p>
    </Card>
  );
}

const cardStyle: CSSProperties = {
  padding: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  textAlign: 'center',
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.75rem',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: '1.5rem', fontWeight: 800 };
const hintStyle: CSSProperties = { margin: 0, fontSize: '0.85rem', color: 'var(--np-text-mute)' };
const stepStyle: CSSProperties = { margin: 0, fontSize: '1.125rem', fontWeight: 700 };

const dotsStyle: CSSProperties = { display: 'flex', justifyContent: 'center', gap: '1rem', padding: '0.5rem 0' };
const dotStyle: CSSProperties = {
  width: '1.1rem',
  height: '1.1rem',
  borderRadius: '50%',
  border: '2px solid var(--np-border-hi)',
};
const dotFull: CSSProperties = { background: 'var(--np-accent)', borderColor: 'var(--np-accent)' };

/** Solo para lectores de pantalla. */
const srOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const errorStyle: CSSProperties = { margin: 0, fontSize: '0.95rem', color: 'var(--np-danger)', fontWeight: 600 };

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '0.6rem',
};

const keyStyle: CSSProperties = {
  minHeight: '4.25rem',
  fontSize: '1.75rem',
  fontWeight: 800,
  borderRadius: 'var(--np-r-lg)',
  border: '2px solid var(--np-border-hi)',
  background: 'var(--np-surface-2)',
  color: 'var(--np-text)',
  cursor: 'pointer',
  fontVariantNumeric: 'tabular-nums',
};

const sideKey: CSSProperties = { fontSize: '1rem', fontWeight: 700, color: 'var(--np-text-mute)' };
