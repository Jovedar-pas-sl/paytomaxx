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
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', width: '100%' }}>
      {label ? <span style={labelStyle}>{label}</span> : null}
      <span style={inputWrap}>
        <input
          {...rest}
          style={{
            ...inputBase,
            ...(size === 'lg' ? sizeLg : sizeMd),
            borderColor: error ? 'var(--np-danger)' : 'var(--np-border)',
            paddingRight: rightSlot ? '4.5rem' : undefined,
            ...style,
          }}
        />
        {rightSlot ? <span style={slotStyle}>{rightSlot}</span> : null}
      </span>
      {error ? (
        <span style={{ ...hintStyle, color: 'var(--np-danger)' }}>{error}</span>
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

export function Select({ label, hint, style, children, ...rest }: SelectProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', width: '100%' }}>
      {label ? <span style={labelStyle}>{label}</span> : null}
      <select
        {...rest}
        style={{
          ...inputBase,
          ...sizeMd,
          appearance: 'none',
          backgroundImage:
            'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 12 8\' fill=\'none\' stroke=\'%23999\' stroke-width=\'1.5\' stroke-linecap=\'round\'><path d=\'M2 2 L6 6 L10 2\'/></svg>")',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 1rem center',
          backgroundSize: '0.75rem',
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
  fontSize: '0.75rem',
  fontWeight: 500,
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
  fontSize: '1rem',
  fontWeight: 500,
  color: 'var(--np-text)',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  outline: 'none',
  transition: 'border-color var(--np-d-fast), box-shadow var(--np-d-fast)',
};

const sizeMd: CSSProperties = { height: '3rem' };
const sizeLg: CSSProperties = { height: '3.75rem', fontSize: '1.5rem', fontWeight: 600 };

const slotStyle: CSSProperties = {
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  alignItems: 'center',
};

const hintStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
};
