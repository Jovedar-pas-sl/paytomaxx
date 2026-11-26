'use client';

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

/**
 * Los campos (Piezas I, idea 59). La etiqueta va enlazada con su campo (label
 * for → id) y fuera de él; la pista y el error, debajo, enlazados para el
 * lector de pantalla (aria-describedby). Estilos en pieces.css: .np-field.
 */
interface FieldText {
  label?: string;
  hint?: string;
  /** Lo que está mal en este campo: lo marca (aria-invalid) y se lee con él. */
  error?: string;
}

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, FieldText {
  size?: 'md' | 'lg';
  /** La unidad fija a la derecha («€»): no se lee; la etiqueta la dice («Importe en euros»). */
  suffix?: string;
}

export function Input({ label, hint, error, size = 'md', suffix, id, className, type, ...rest }: InputProps) {
  const own = useId();
  const fieldId = id ?? own;
  const help = fieldHelp(fieldId, hint, error, rest['aria-describedby'], rest['aria-invalid']);
  const password = type === 'password';
  const [shown, setShown] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  // Nace oculta (también si se desmonta enseñada). Enseñada, se vuelve a ocultar al enviar su formulario: el
  // navegador la guarda como contraseña, no como texto.
  useEffect(() => {
    const form = toggle.current?.form;
    if (!shown || !form) return undefined;
    const hide = () => setShown(false);
    form.addEventListener('submit', hide);
    return () => form.removeEventListener('submit', hide);
  }, [shown]);

  return (
    <div className="np-field">
      {label ? (
        <label className="np-field-label" htmlFor={fieldId}>
          {label}
          {suffix ? <span className="np-sr-only">{suffix === '€' ? ' en euros' : ` ${suffix}`}</span> : null}
        </label>
      ) : null}
      <div className="np-field-box">
        <input
          {...rest}
          {...help.attrs}
          id={fieldId}
          type={password && shown ? 'text' : type}
          // Una contraseña nunca pasa por el corrector ni el teclado le pone mayúsculas (tampoco al enseñarla).
          {...(password ? { spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off' } : {})}
          className={['np-field-input', className].filter(Boolean).join(' ')}
          data-size={size === 'lg' ? 'lg' : undefined}
          data-end={suffix || password ? '' : undefined}
          data-revealed={password && shown ? '' : undefined}
        />
        {suffix ? (
          <span className="np-field-suffix" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
        {password ? (
          // Fuera del <label> (un botón dentro de una etiqueta no es HTML válido) y dentro de la caja, a la derecha.
          <button
            ref={toggle}
            type="button"
            className="np-field-reveal"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Ocultar contraseña' : 'Ver contraseña'}
            disabled={rest.disabled}
          >
            {shown ? 'Ocultar' : 'Ver'}
          </button>
        ) : null}
      </div>
      {help.node}
    </div>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldText {}

export function Select({ label, hint, error, id, className, children, ...rest }: SelectProps) {
  const own = useId();
  const fieldId = id ?? own;
  const help = fieldHelp(fieldId, hint, error, rest['aria-describedby'], rest['aria-invalid']);
  return (
    <div className="np-field">
      {label ? (
        <label className="np-field-label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <select
        {...rest}
        {...help.attrs}
        id={fieldId}
        // np-select: la flecha, con el color de cada tema (styles.css).
        className={['np-select', 'np-field-input', className].filter(Boolean).join(' ')}
      >
        {children}
      </select>
      {help.node}
    </div>
  );
}

/**
 * La pista o el error de debajo, con su id, y lo que el campo necesita para
 * leerlos: aria-describedby (sin perder el que traiga quien lo usa, p. ej. el
 * FormError de encima del botón) y aria-invalid con el error.
 */
function fieldHelp(fieldId: string, hint: string | undefined, error: string | undefined, describedBy: string | undefined, invalid: InputProps['aria-invalid']) {
  const helpId = `${fieldId}-help`;
  const text = error || hint;
  const node: ReactNode = text ? (
    <span id={helpId} className={error ? 'np-field-hint np-field-error' : 'np-field-hint'}>
      {text}
    </span>
  ) : null;
  const ids = [describedBy, text ? helpId : undefined].filter(Boolean).join(' ');
  return {
    node,
    attrs: { 'aria-describedby': ids || undefined, 'aria-invalid': error ? true : invalid },
  };
}
