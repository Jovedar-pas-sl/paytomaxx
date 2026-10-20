'use client';

import type { CSSProperties } from 'react';
import type { SectionCode, VenueSection } from '@nightpay/contracts';

/**
 * «Otro importe»: ¿de qué es? Botones grandes con el color de cada sección;
 * la del puesto de quien cobra ya viene marcada. Sin sección no se cobra.
 */
export function SectionPicker({
  sections,
  value,
  onChange,
  disabled,
}: {
  sections: readonly VenueSection[];
  value: SectionCode;
  onChange: (next: SectionCode) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 'none', minWidth: 0 }}>
      <legend className="np-short-sr-only" style={legendStyle}>
        ¿De qué es?
      </legend>
      <div style={gridStyle}>
        {sections.map((s) => {
          const on = s.code === value;
          return (
            <button
              key={s.code}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(s.code)}
              style={{
                ...btnStyle,
                borderColor: s.color,
                ...(on ? { background: s.color, color: '#14110f', fontWeight: 800 } : {}),
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

const legendStyle: CSSProperties = {
  padding: 0,
  marginBottom: '0.5rem',
  fontSize: 'var(--np-t-label)',
  fontWeight: 700,
  color: 'var(--np-text-label)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(7.5rem, 1fr))',
  gap: '0.5rem',
};

// 56 px: se toca a oscuras y con prisa.
const btnStyle: CSSProperties = {
  minHeight: '3.5rem',
  padding: '0.5rem 0.75rem',
  background: 'transparent',
  border: '3px solid',
  borderRadius: 'var(--np-r-md)',
  color: 'var(--np-text)',
  fontSize: '1.0625rem',
  fontWeight: 700,
  cursor: 'pointer',
};
