import type { ButtonHTMLAttributes } from 'react';

/**
 * El juego de iconos de las apps (Piezas I): dibujos de línea propios sobre una
 * rejilla de 24, sin relleno, con puntas redondas y del color del texto
 * (currentColor). Son los trazos que ya había, copiados: el ✓ de PAGADO, el
 * «!» de FormError, la lista de la barra de pestañas… Todo son trazos: los
 * círculos van como arcos y los puntos, como un trazo de 0,01. Un icono nuevo
 * es una línea más aquí, y solo cuando alguien lo usa.
 */
const CIRCLE_9 = 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z';

export const ICON_PATHS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: [CIRCLE_9, 'M12 7.5v5.5', 'M12 16.5h.01'],
  error: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  info: [CIRCLE_9, 'M12 11v6', 'M12 7.5h.01'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z', 'M12 7.5V12l3 2'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;

/** El dibujo, al tamaño y grosor que se pida (Etiqueta lo pinta a 14 con trazo de 3,4). Siempre decorativo. */
export function IconSvg({ name, size, strokeWidth, className }: { name: IconName; size: number; strokeWidth: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

interface IconProps {
  name: IconName;
  /** Lado en px (por defecto 24). */
  size?: 20 | 24 | 28;
  className?: string;
}

/** Un icono, solo decorativo (lo que significa lo dice el texto de al lado o el nombre del botón). */
export function Icon({ name, size = 24, className }: IconProps) {
  // 48 / tamaño: 2 px a la vista en los tres tamaños.
  return <IconSvg name={name} size={size} strokeWidth={48 / size} className={className} />;
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: IconName;
  /** Lo que hace, en una o dos palabras («Cerrar»): se lee (aria-label) y sale al pasar el ratón (title). */
  label: string;
  /** `quiet` (por defecto): sin fondo ni filete. `ghost`: como el botón secundario. */
  variant?: 'quiet' | 'ghost';
}

/** Un botón redondo de solo icono (estilos en pieces.css: .np-iconbtn). No existe sin su nombre. */
export function IconButton({ icon, label, variant = 'quiet', className, ...rest }: IconButtonProps) {
  return (
    <button type="button" {...rest} aria-label={label} title={label} data-variant={variant} className={['np-iconbtn', className].filter(Boolean).join(' ')}>
      <Icon name={icon} />
    </button>
  );
}
