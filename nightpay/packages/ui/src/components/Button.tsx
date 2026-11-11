import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /**
   * Mientras carga, en vez del círculo: esta palabra con tres puntos («Cobrando»).
   * El botón sigue deshabilitado (no se cobra dos veces) y en su color.
   */
  loadingLabel?: string;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingLabel,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const cls = ['np-btn', className].filter(Boolean).join(' ');

  return (
    // type="button" por defecto: dentro de un <form> no lo envía sin querer (quien quiera, pasa type="submit").
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      className={cls}
    >
      {loading && loadingLabel ? (
        <BusyWord word={loadingLabel} />
      ) : (
        <>
          {loading ? <Spinner /> : null}
          <span style={{ opacity: loading ? 0 : 1, transition: 'opacity 150ms' }}>{children}</span>
        </>
      )}
    </button>
  );
}

/** «Cobrando» con tres puntos que suben y bajan (sin animación si se reduce el movimiento). */
export function BusyWord({ word }: { word: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <span aria-hidden className="np-dots">
        <i />
        <i />
        <i />
      </span>
      <span>{word}</span>
    </span>
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
    </span>
  );
}
