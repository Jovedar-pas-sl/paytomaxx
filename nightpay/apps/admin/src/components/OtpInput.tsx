'use client';

import { useEffect, useId, useRef, type ClipboardEvent } from 'react';
import { formatDateTime } from '@/lib/dates';
import { OTP_LENGTH, extractOtp, justCompleted, sanitizeOtp } from '@/lib/otp';
import { useLockActive } from '@/lib/use-lock';
import { useVenueTimezone } from '@/lib/venue-context';

interface Props {
  label: string;
  value: string;
  onChange: (code: string) => void;
  /**
   * Al completar las 6 cifras, enviar el formulario donde está (una vez por
   * código). false = solo rellenar (p. ej. aún falta marcar una casilla).
   */
  autoSubmit?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /**
   * Bloqueado por demasiados códigos malos (429 del API) hasta este instante
   * (epoch ms): el campo no deja escribir y vuelve solo al acabar.
   */
  lockedUntil?: number | null;
  autoFocus?: boolean;
  required?: boolean;
}

/**
 * Código de la app de verificación en 6 casillas. Por debajo es un solo campo
 * (autocomplete="one-time-code", teclado numérico): pegar el código entero,
 * el autocompletado del móvil y el lector de pantalla funcionan solos. Las
 * casillas solo lo pintan, con la activa marcada en lima.
 */
export function OtpInput({
  label,
  value,
  onChange,
  autoSubmit = false,
  hint,
  error,
  disabled,
  lockedUntil,
  autoFocus,
  required,
}: Props) {
  const tz = useVenueTimezone();
  const locked = useLockActive(lockedUntil ?? null);
  const id = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  /** Se acaba de completar: se envía tras pintar el valor nuevo (el formulario lo lee ya puesto). */
  const pendingSubmit = useRef(false);

  useEffect(() => {
    if (!pendingSubmit.current) return;
    pendingSubmit.current = false;
    if (autoSubmit && value.length === OTP_LENGTH) submitForm(input.current?.form ?? null);
  }, [value, autoSubmit]);

  function update(next: string): void {
    if (next === value) return;
    pendingSubmit.current = justCompleted(value, next);
    onChange(next);
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>): void {
    const code = extractOtp(e.clipboardData.getData('text'));
    if (!code) return;
    e.preventDefault();
    update(code);
  }

  // El cursor siempre al final: se borra y se escribe por orden, como en las casillas.
  function keepCaretAtEnd(): void {
    const el = input.current;
    if (el && el.selectionStart !== el.value.length) el.setSelectionRange(el.value.length, el.value.length);
  }

  const active = Math.min(value.length, OTP_LENGTH - 1);
  const lockText =
    locked && lockedUntil
      ? `Demasiados códigos incorrectos: podrás probar otro a las ${formatDateTime(new Date(lockedUntil), tz, 'time')}.`
      : null;
  const describedBy = error || hint || lockText ? hintId : undefined;

  return (
    <div className="np-otp">
      <label htmlFor={id} className="np-otp-label">
        {label}
      </label>
      <div className="np-otp-field" data-invalid={error ? 'true' : undefined}>
        <input
          ref={input}
          id={id}
          className="np-otp-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={`\\d{${OTP_LENGTH}}`}
          spellCheck={false}
          value={value}
          onChange={(e) => update(sanitizeOtp(e.target.value))}
          onPaste={onPaste}
          onSelect={keepCaretAtEnd}
          onFocus={keepCaretAtEnd}
          disabled={disabled || locked}
          autoFocus={autoFocus}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <div className="np-otp-boxes" aria-hidden="true">
          {Array.from({ length: OTP_LENGTH }, (_, n) => (
            <span
              key={n}
              className="np-otp-box"
              data-filled={n < value.length ? 'true' : 'false'}
              data-active={n === active ? 'true' : 'false'}
            >
              {value[n] ?? ''}
            </span>
          ))}
        </div>
      </div>
      {lockText ? (
        <span id={hintId} className="np-otp-error" role="status">
          {lockText}
        </span>
      ) : error ? (
        <span id={hintId} className="np-otp-error">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="np-otp-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** requestSubmit valida el formulario y pasa por su onSubmit (Safari < 16: evento a mano). */
function submitForm(form: HTMLFormElement | null): void {
  if (!form) return;
  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
}
