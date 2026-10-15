'use client';

import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { formatEur } from '../format';
import {
  DEFAULT_KEYPAD_MAX_CENTS,
  KEYPAD_LAYOUT,
  keypadKeyFromKeyboard,
  keypadKeyLabel,
  pressKeypad,
  type KeypadKey,
} from '../lib/amount-keypad';

interface AmountKeypadProps {
  valueCents: number;
  onChange: (cents: number) => void;
  /** Tope del importe (por defecto 100.000 €). */
  maxCents?: number;
  label?: string;
  disabled?: boolean;
  /**
   * Teclado físico (TPV de sobremesa): cifras, Retroceso, Supr (borra todo) e
   * Intro (onEnter). No escucha si se escribe en otro campo.
   */
  captureKeyboard?: boolean;
  onEnter?: () => void;
}

/**
 * Teclado de importe propio, 3×4 y siempre en el mismo orden: se teclea en
 * céntimos, como en un datáfono (5-0-0-0 → 50,00 €), sin el teclado del
 * sistema tapando media pantalla. El botón de cobrar lo pone quien lo usa.
 */
export function AmountKeypad({
  valueCents,
  onChange,
  maxCents = DEFAULT_KEYPAD_MAX_CENTS,
  label = 'Importe',
  disabled = false,
  captureKeyboard = false,
  onEnter,
}: AmountKeypadProps) {
  const labelId = useId();
  const latest = useRef({ valueCents, onChange, maxCents, disabled, onEnter });
  useEffect(() => {
    latest.current = { valueCents, onChange, maxCents, disabled, onEnter };
  });

  useEffect(() => {
    if (!captureKeyboard) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      const s = latest.current;
      if (s.disabled || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      if (isTextEntry(e.target)) return;
      if (e.key === 'Enter') {
        // Sobre un botón, Intro ya lo pulsa: no se cobra dos veces.
        if (!isInteractive(e.target) && s.onEnter) {
          e.preventDefault();
          s.onEnter();
        }
        return;
      }
      const key = keypadKeyFromKeyboard(e.key);
      if (!key) return;
      e.preventDefault();
      s.onChange(pressKeypad(s.valueCents, key, s.maxCents));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [captureKeyboard]);

  function press(key: KeypadKey) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(8);
    onChange(pressKeypad(valueCents, key, maxCents));
  }

  const shown = formatEur(valueCents);
  return (
    <div className="np-keypad">
      <div className="np-keypad-display" data-empty={valueCents === 0 ? 'true' : 'false'}>
        <span id={labelId} className="np-keypad-label">
          {label}
        </span>
        <output
          aria-labelledby={labelId}
          aria-live="polite"
          className="np-keypad-amount"
          style={{ '--np-fit': Math.max(4, shown.length * 0.8).toFixed(2) } as CSSProperties}
        >
          {shown}
        </output>
      </div>
      <div className="np-keypad-grid" role="group" aria-label="Teclado del importe">
        {KEYPAD_LAYOUT.map((key) => (
          <button
            key={key}
            type="button"
            className="np-keypad-key"
            data-key={key}
            aria-label={key === 'back' || key === '00' ? keypadKeyLabel(key) : undefined}
            onClick={() => press(key)}
            disabled={disabled || (key === 'back' && valueCents === 0)}
          >
            {key === 'back' ? <BackIcon /> : key}
          </button>
        ))}
      </div>
    </div>
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['BUTTON', 'A'].includes(target.tagName);
}

function BackIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z" />
      <path d="M12 9.5l5 5M17 9.5l-5 5" />
    </svg>
  );
}
