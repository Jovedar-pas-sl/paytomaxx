import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';
type Size = 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const cls = ['np-btn', className].filter(Boolean).join(' ');

  return (
    <button
      {...rest}
      disabled={isDisabled}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      className={cls}
    >
      {loading ? <Spinner /> : null}
      <span style={{ opacity: loading ? 0 : 1, transition: 'opacity 150ms' }}>{children}</span>
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        style={{
          width: '1.25rem',
          height: '1.25rem',
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'np-spin 700ms linear infinite',
        }}
      />
      <style>{`@keyframes np-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
