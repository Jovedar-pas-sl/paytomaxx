'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Card, haptic, pinFailed, shakeClass } from '@nightpay/ui';
import { WALLET_PIN_PROBLEM_TEXT, walletPinProblem } from '@nightpay/contracts';
import { PIN_CHOOSE, PIN_CHOOSE_HINT, PIN_ENTER, PIN_REPEAT, keypadDigits } from '@/lib/pin-pad';
import { useVenueNight } from '@/lib/venue-methods';

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
  /** La tecla de salir: «Cancelar» (de fábrica) o «Ahora no» (el PIN tras cargar, B1). */
  cancelLabel?: string;
  /** Encima del teclado: lo que acaba de pasar (p. ej. «Cargado 50 €»), para quien lo atiende. */
  top?: ReactNode;
}

/**
 * Teclado del PIN para el cliente, en el móvil de la chica. Como diga el local
 * (Ajustes → Noche): fijo y con las teclas grandes (de fábrica: a oscuras se
 * acierta mejor y el cliente lo tapa con la mano) o con las cifras cambiando
 * de sitio en cada intento. Solo se ven puntos y no es un campo de texto (el
 * móvil no lo recuerda ni lo sugiere).
 */
export function PinPad({ title, hint, mode, onPin, onCancel, cancelLabel = 'Cancelar', top = null }: Props) {
  const layout = useVenueNight().pinKeypad;
  const shuffled = layout === 'shuffled';
  const [keys, setKeys] = useState<string[]>(() => keypadDigits(layout));
  // Los ajustes del local llegan después de pintar: el teclado se pone al día.
  useEffect(() => setKeys(keypadDigits(layout)), [layout]);
  const [pin, setPin] = useState('');
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  function restart(message: string | null, keepFirst = false): void {
    setPin('');
    if (!keepFirst) setFirst(null);
    setError(message);
    // Un PIN que no vale: los puntos tiemblan y el móvil vibra [30, 60, 30].
    if (message) {
      setShake((n) => n + 1);
      pinFailed();
    }
    setKeys(keypadDigits(layout));
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
    haptic();
    const next = pin + digit;
    setPin(next);
    setError(null);
    if (next.length === PIN_LENGTH) void complete(next);
  }

  const step = mode === 'enter' ? PIN_ENTER : first === null ? PIN_CHOOSE : PIN_REPEAT;
  const key = shuffled ? keyStyle : { ...keyStyle, ...bigKey };

  return (
    <Card style={cardStyle}>
      {top}
      <p style={kicker}>Para el cliente</p>
      <p style={titleStyle}>{title}</p>
      {hint ? <p style={hintStyle}>{hint}</p> : null}
      <p style={stepStyle}>
        {step.es}{' '}
        <span lang="en" style={enStyle}>
          · {step.en}
        </span>
      </p>
      <div role="status" style={dotsStyle} className={shakeClass(shake) || undefined}>
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
          <button key={d} type="button" style={key} onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <button type="button" style={{ ...key, ...sideKey }} onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" style={key} onClick={() => press(keys[9]!)} disabled={busy}>
          {keys[9]}
        </button>
        <button
          type="button"
          aria-label="Borrar"
          style={{ ...key, ...sideKey }}
          onClick={() => setPin((p) => p.slice(0, -1))}
          disabled={busy || pin.length === 0}
        >
          ⌫
        </button>
      </div>
      <p style={hintStyle}>
        {mode === 'choose' ? (
          <>
            {PIN_CHOOSE_HINT.es}
            <br />
            <span lang="en">{PIN_CHOOSE_HINT.en}</span>
          </>
        ) : shuffled
            ? 'Tápalo con la mano. Las cifras cambian de sitio cada vez.'
            : 'Tápalo con la mano.'}
      </p>
    </Card>
  );
}

const cardStyle: CSSProperties = {
  padding: 'min(1.25rem, var(--np-pad-card))',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  textAlign: 'center',
};

// Grafito: sin mayúsculas ni espaciado, 14/500; título 22/600 y paso 18/600.
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-22)', fontWeight: 600 };
const hintStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };
const stepStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-18)', fontWeight: 600 };
// La línea en inglés, detrás y en t2: se lee sin competir con la española.
const enStyle: CSSProperties = { fontSize: 'var(--np-fs-16)', fontWeight: 500, color: 'var(--np-text-mute)' };

const dotsStyle: CSSProperties = { display: 'flex', justifyContent: 'center', gap: '1rem', padding: '0.5rem 0' };
const dotStyle: CSSProperties = {
  width: '1.125rem',
  height: '1.125rem',
  borderRadius: '50%',
  border: '2px solid var(--np-text)',
  transition: 'background var(--np-d-fast), transform var(--np-d-fast)',
};
// Las cifras puestas, en crema: la lima es para actuar, no para el progreso.
const dotFull: CSSProperties = { background: 'var(--np-text)', transform: 'scale(1.1)' };

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

const errorStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-danger-text)', fontWeight: 500 };

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '0.5rem',
};

// Teclas del PIN: 60 px como poco (más en una pantalla alta, como el teclado
// del importe con --np-key-h), radio 14, filete de 1 px y cifras en Manrope 600.
const keyStyle: CSSProperties = {
  minHeight: 'max(3rem, var(--np-key-h, 4.25rem))',
  fontFamily: 'var(--np-font-num)',
  fontSize: 'var(--np-fs-28)',
  fontWeight: 600,
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  background: 'var(--np-surface-2)',
  color: 'var(--np-text)',
  cursor: 'pointer',
  fontVariantNumeric: 'tabular-nums',
};

const sideKey: CSSProperties = { fontFamily: 'var(--np-font-sans)', fontSize: 'var(--np-fs-16)', fontWeight: 500, color: 'var(--np-text-mute)' };

/** Teclado fijo: las teclas, más grandes (se aciertan a oscuras y con prisa). */
const bigKey: CSSProperties = { minHeight: 'max(3.25rem, calc(var(--np-key-h, 4.25rem) + 0.5rem))', fontSize: 'var(--np-fs-28)' };
