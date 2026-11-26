'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface CheckboxProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  /** Solo cambia el formulario: se guarda con su botón «Guardar». */
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Unas sí y otras no (la casilla de «todas»): una raya en lugar del ✓. */
  indeterminate?: boolean;
}

/**
 * La casilla que espera a «Guardar»: una casilla nativa (el teclado y el
 * lector de pantalla la tratan como tal) con nuestro dibujo, dentro de su
 * etiqueta para que la fila entera se toque. Lo que se guarda al tocar es un
 * Switch. Estilos en pieces-2.css: .np-checkbox.
 */
export function Checkbox({ label, hint, checked, onChange, disabled, indeterminate = false }: CheckboxProps) {
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  // «A medias» no es un atributo: se le dice a la casilla.
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className="np-checkbox" data-disabled={disabled ? '' : undefined}>
      <span className="np-checkbox-box">
        <input
          ref={input}
          type="checkbox"
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          data-mixed={indeterminate ? '' : undefined}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <Icon name={indeterminate ? 'minus' : 'check'} size={20} />
      </span>
      <span className="np-checkbox-text">
        <span className="np-checkbox-label">{label}</span>
        {hint ? (
          <span id={hintId} className="np-checkbox-hint">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}
