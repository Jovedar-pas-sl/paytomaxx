import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

type CardVariant = 'default' | 'elevated' | 'glow';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  children: ReactNode;
}

/**
 * Tarjeta. Los hijos van directamente dentro: el `display`, `gap`,
 * `alignItems`… que se le pasen en `style` les llegan (antes iban dentro de
 * un <div> de bloque, resto del borde de brillo que ya no existe, y una
 * tarjeta en columna salía sin huecos y con botones de anchos distintos).
 */
export function Card({ variant = 'default', children, style, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      data-variant={variant}
      style={{ ...base, ...variantStyles[variant], ...style }}
    >
      {children}
    </div>
  );
}

const base: CSSProperties = {
  position: 'relative',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-lg)',
  padding: 'var(--np-s-5)',
  isolation: 'isolate',
};

const variantStyles: Record<CardVariant, CSSProperties> = {
  default: {},
  elevated: {
    background: 'var(--np-surface-2)',
    borderColor: 'var(--np-border-hi)',
  },
  // "glow" = tarjeta destacada: borde lima sólido, sin degradados.
  glow: {
    background: 'var(--np-surface)',
    border: '2px solid var(--np-accent)',
  },
};
