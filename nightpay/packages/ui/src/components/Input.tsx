import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  hint?: string;
  error?: string;
  size?: 'md' | 'lg';
  rightSlot?: ReactNode;
}

export function Input({
  label,
  hint,
  error,
  size = 'md',
  rightSlot,
  style,
  ...rest
}: InputProps) {
  // Marcado en rojo con su error o si quien lo usa lo marca (aria-invalid: p. ej. un FormError aparte).
  const invalid = Boolean(error) || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', width: '100%' }}>
      {label ? <span style={labelStyle}>{label}</span> : null}
      <span style={inputWrap}>
        <input
          {...rest}
          style={{
            ...inputBase,
            ...(size === 'lg' ? sizeLg : sizeMd),
            borderColor: invalid ? 'var(--np-danger)' : 'var(--np-border)',
            paddingRight: rightSlot ? '4.5rem' : undefined,
            ...style,
          }}
        />
        {rightSlot ? <span style={slotStyle}>{rightSlot}</span> : null}
      </span>
      {error ? (
        <span style={{ ...hintStyle, color: 'var(--np-danger-text)' }}>{error}</span>
      ) : hint ? (
        <span style={hintStyle}>{hint}</span>
      ) : null}
    </label>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
}

export function Select({ label, hint, style, className, children, ...rest }: SelectProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', width: '100%' }}>
      {label ? <span style={labelStyle}>{label}</span> : null}
      <select
        {...rest}
        // np-select: la flecha, con el color de cada tema (styles.css).
        className={['np-select', className].filter(Boolean).join(' ')}
        style={{
          ...inputBase,
          ...sizeMd,
          paddingRight: '2.5rem',
          ...style,
        }}
      >
        {children}
      </select>
      {hint ? <span style={hintStyle}>{hint}</span> : null}
    </label>
  );
}

const labelStyle: CSSProperties = {
  fontSize: '0.8125rem',
  fontWeight: 700,
  color: 'var(--np-text-mute)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const inputWrap: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  width: '100%',
};

const inputBase: CSSProperties = {
  width: '100%',
  padding: '0 1rem',
  fontFamily: 'var(--np-font-sans)',
  fontSize: '1.0625rem',
  fontWeight: 500,
  color: 'var(--np-text)',
  // backgroundColor (no `background`): el atajo borraría la flecha de .np-select.
  backgroundColor: 'var(--np-surface)',
  border: '2px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  // Sin outline: 'none': con el teclado se ve el anillo de :focus-visible.
  transition: 'border-color var(--np-d-fast), box-shadow var(--np-d-fast)',
};

const sizeMd: CSSProperties = { height: '3.5rem' };
const sizeLg: CSSProperties = { height: '4.5rem', fontSize: '2rem', fontWeight: 700 };

const slotStyle: CSSProperties = {
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  alignItems: 'center',
};

const hintStyle: CSSProperties = {
  fontSize: '0.8125rem',
  color: 'var(--np-text-dim)',
};
