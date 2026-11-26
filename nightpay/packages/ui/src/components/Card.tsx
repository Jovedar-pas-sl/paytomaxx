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
 *
 * El relleno, el filete, el radio y la sombra (el relieve) los pone la clase
 * .np-card de styles.css, también los de cada variante (data-variant):
 * "elevated", un paso más clara; "glow", la destacada, con borde lima (tinta
 * en claro). Lo que se pase en `style` sigue mandando.
 */
export function Card({ variant = 'default', children, className, style, ...rest }: CardProps) {
  return (
    <div {...rest} className={className ? `np-card ${className}` : 'np-card'} data-variant={variant} style={{ ...base, ...style }}>
      {children}
    </div>
  );
}

const base: CSSProperties = {
  position: 'relative',
  padding: 'var(--np-s-5)',
  isolation: 'isolate',
};
