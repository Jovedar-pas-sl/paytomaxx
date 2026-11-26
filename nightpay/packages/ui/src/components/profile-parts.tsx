'use client';

import { useId, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';

// Piezas de «Mi perfil»: bloque con título, selector de opciones y mensajes.
// Grafito: superficies --np-surface y --np-surface-2, texto crema, lo elegido en crema
// (nunca en lima), mínimo 14 px y 44 px de zona de toque.

export const TOUCH_MIN = '2.75rem';

/** Un bloque de la pantalla («Tu foto y tu nombre», «Contacto»…). */
export function ProfileBlock({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} style={blockStyle}>
      <h2 id={id} style={blockTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Elegir una opción entre pocas (Tema, Vibrar, Letra): la elegida va en crema con tinta. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (next: T) => void;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <span id={id} style={labelStyle}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              style={{
                ...optionStyle,
                background: on ? 'var(--np-chosen)' : 'var(--np-surface-2)',
                color: on ? 'var(--np-on-chosen)' : 'var(--np-text)',
                borderColor: on ? 'var(--np-chosen)' : 'var(--np-border-hi)',
                fontWeight: on ? 600 : 400,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** El resultado de un guardado: verde si salió bien, rojo si no (con texto, nunca solo color). */
export function Notice({ kind, children }: { kind: 'ok' | 'error'; children: ReactNode }) {
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} style={{ ...noticeStyle, color: kind === 'error' ? 'var(--np-danger-text)' : 'var(--np-text)' }}>
      {kind === 'ok' ? <Icon name="check" size={20} className="np-icon-lead" /> : null}
      {children}
    </p>
  );
}

export const rowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
export const actionsStyle: CSSProperties = { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' };
export const touchButton: CSSProperties = { minHeight: TOUCH_MIN };

// Con el relieve de las tarjetas (las mismas fichas que .np-card).
const blockStyle: CSSProperties = {
  backgroundColor: 'var(--np-surface)',
  backgroundImage: 'var(--np-card-fill)',
  border: '1px solid var(--np-card-edge)',
  borderRadius: 'var(--np-r-card)',
  boxShadow: 'var(--np-shadow-1)',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
  minWidth: 0,
};
const blockTitle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-18)',
  fontWeight: 600,
  color: 'var(--np-text)',
};
const labelStyle: CSSProperties = { fontSize: 'var(--np-fs-14)', color: 'var(--np-text-label)' };
const optionStyle: CSSProperties = {
  minHeight: TOUCH_MIN,
  padding: '0 0.875rem',
  borderRadius: 'var(--np-r-sm)',
  border: '1px solid',
  fontSize: 'var(--np-fs-16)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const noticeStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', lineHeight: 1.4 };
