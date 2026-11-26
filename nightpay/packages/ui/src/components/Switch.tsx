'use client';

import { useId } from 'react';

interface SwitchProps {
  label: string;
  hint?: string;
  checked: boolean;
  /** Se guarda aquí, al tocarlo; el resultado («Guardado» o el error) lo enseña quien lo usa. */
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

/**
 * El interruptor Sí / No que guarda solo (role="switch"): una fila con su
 * texto a la izquierda y el interruptor a la derecha. La palabra va escrita
 * dentro y la bolita se desliza, así se lee «Sí» o «No» sin fiarse del color.
 * Lo que espera a «Guardar» es un Checkbox. Estilos en pieces-2.css: .np-switch.
 */
export function Switch({ label, hint, checked, onChange, disabled }: SwitchProps) {
  const hintId = useId();
  return (
    <div className="np-switch-row">
      <div className="np-switch-row-text">
        <span className="np-switch-row-label">{label}</span>
        {hint ? (
          <span id={hintId} className="np-switch-row-hint">
            {hint}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        className="np-switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="np-switch-thumb" aria-hidden="true" />
        <span className="np-switch-text" aria-hidden="true">
          {checked ? 'Sí' : 'No'}
        </span>
      </button>
    </div>
  );
}
