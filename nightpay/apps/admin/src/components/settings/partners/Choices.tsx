'use client';

import { useId } from 'react';

/** Una sola opción de varias (entrega de la clave, solape): botones de radio grandes, con su explicación. */
export function RadioChoices<T extends string>({
  legend,
  options,
  value,
  onChange,
  disabled,
}: {
  legend: string;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="np-ptn-fieldset">
      <legend className="np-ptn-label">{legend}</legend>
      <div className="np-ptn-radios">
        {options.map((o) => (
          <label key={o.value} className="np-ptn-radio" data-checked={o.value === value ? 'true' : undefined}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} disabled={disabled} />
            <span>
              <span className="np-ptn-radio-label">{o.label}</span>
              {o.hint ? <span className="np-ptn-help">{o.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
