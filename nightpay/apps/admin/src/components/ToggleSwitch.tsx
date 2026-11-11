'use client';

import { useId, type ReactNode } from 'react';

/**
 * Interruptor Sí / No (role="switch"): la palabra va escrita dentro y la bolita
 * se desliza, así que se lee «Sí» o «No» sin fiarse del color. Estilos en
 * styles/panel-grafito.css.
 */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="np-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="np-switch-thumb" aria-hidden="true" />
      <span className="np-switch-text" aria-hidden="true">
        {checked ? 'Sí' : 'No'}
      </span>
    </button>
  );
}

/** Una línea de un formulario con su interruptor a la derecha (en vez de una casilla). */
export function SwitchLine({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="np-switch-line">
      <span id={id}>{children}</span>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} labelledBy={id} />
    </div>
  );
}
