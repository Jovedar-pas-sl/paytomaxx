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
const BELL = ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'];

export const ICON_PATHS = {
  // Estados y avisos (Etiqueta, FormError, ventanas).
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: [CIRCLE_9, 'M12 7.5v5.5', 'M12 16.5h.01'],
  error: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  info: [CIRCLE_9, 'M12 11v6', 'M12 7.5h.01'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z', 'M12 7.5V12l3 2'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  // Moverse y teclear.
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  backspace: ['M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z', 'M12 9.5l5 5', 'M17 9.5l-5 5'],
  dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  // Cobrar.
  qr: [
    'M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
    'M15 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
    'M5 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z',
    'M14 14h2v2',
    'M20 14v.01',
    'M14 20h.01',
    'M17 17h3v3h-3z',
  ],
  nfc: ['M8 9a5 5 0 0 1 0 6', 'M11.5 6.5a9 9 0 0 1 0 11', 'M15 4a13 13 0 0 1 0 16'],
  lock: ['M7.5 10.5h9a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 18v-5a2.5 2.5 0 0 1 2.5-2.5Z', 'M8 10.5V7.5a4 4 0 0 1 8 0v3'],
  hand: [
    'M8 13V5.5a1.5 1.5 0 0 1 3 0V11',
    'M11 10V4a1.5 1.5 0 0 1 3 0v7',
    'M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7-2.6 0-4-1.3-5.4-3.4L3.4 15a1.5 1.5 0 0 1 2.4-1.8L8 15.5',
  ],
  flash: ['M13 2.5L5.5 13.5H11l-1 8 7.5-11H12l1-8z'],
  cash: [
    'M4.5 6h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z',
    'M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5Z',
    'M6 12h.01',
    'M18 12h.01',
  ],
  card: ['M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M2.5 10h19', 'M6.5 15h4'],
  // La línea de puntos del ticket, en tres trazos cortos.
  ticket: [
    'M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z',
    'M14 8.25v.5',
    'M14 11.75v.5',
    'M14 15.25v.5',
  ],
  drink: ['M6 3h12l-1.6 17.1a1 1 0 0 1-1 .9H8.6a1 1 0 0 1-1-.9L6 3z', 'M6.6 9h10.8'],
  food: ['M7 3v7a2 2 0 0 0 4 0V3', 'M9 12v9', 'M17 21V3c-2 1-3 3.2-3 6.5V14h3'],
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 6a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3Z'],
  sun: [
    'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8Z',
    'M12 2v2',
    'M12 20v2',
    'm4.93 4.93 1.41 1.41',
    'm17.66 17.66 1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'm4.93 19.07 1.41-1.41',
    'm17.66 6.34 1.41-1.41',
  ],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  bell: BELL,
  'bell-off': [...BELL, 'M4 4l16 16'],
  printer: ['M7 9V3h10v6', 'M7 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-3', 'M7 14h10v7H7z'],
  share: ['M12 3v12', 'm7 8 5-5 5 5', 'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7'],
  // Sin conexión, el servidor, el banco que tarda.
  'wifi-off': ['M2 8.5a15 15 0 0 1 20 0', 'M5 12a10 10 0 0 1 14 0', 'M8.5 15.5a5 5 0 0 1 7 0', 'M12 19h.01', 'M3 3l18 18'],
  'cloud-download': ['M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 7.97', 'M12 12v6', 'M9.5 15.5L12 18l2.5-2.5'],
  hourglass: ['M7 3h10', 'M7 21h10', 'M8 3c0 5 8 5 8 9s-8 4-8 9', 'M16 3c0 5-8 5-8 9s8 4 8 9'],
  // Las pestañas de la app del personal.
  home: ['M3 12L12 3l9 9', 'M5 10v10a1 1 0 0 0 1 1h3v-6h6v6h3a1 1 0 0 0 1-1V10'],
  'concierge-bell': ['M4 18a8 8 0 0 1 16 0', 'M2.5 18h19', 'M12 10V7.5', 'M10 7.5h4'],
  pos: ['M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M8 7h8', 'M8 11h8', 'M9 16h2'],
  wallet: [
    'M17 7V5.5A1.5 1.5 0 0 0 15.5 4H5a2 2 0 0 0-2 2',
    'M5 6h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z',
    'M21 11h-4a2 2 0 0 0 0 4h4',
    'M17 13h.01',
  ],
  sliders: ['M4 7h10', 'M18 7h2', 'M4 17h4', 'M12 17h8', 'M16 5a2 2 0 1 0 0 4a2 2 0 0 0 0-4Z', 'M10 15a2 2 0 1 0 0 4a2 2 0 0 0 0-4Z'],
  // Las secciones del panel (y las de OxioParty).
  // Ajustes → Super admin (una persona).
  user: ['M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 21a7.5 7.5 0 0 1 15 0'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.5a6.5 6.5 0 0 1 3.5 5.5'],
  chart: ['M5 20V11', 'M12 20V5', 'M19 20v-6', 'M3 20h18'],
  activity: ['M3 12h4l3-7 4 14 3-7h4'],
  store: ['M4 10l2-6h12l2 6', 'M4 10h16', 'M4 10a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0', 'M5 12v8h14v-8', 'M10 20v-5h4v5'],
  wristband: ['M12 4a8 4 0 1 0 0 16 8 4 0 1 0 0-16z', 'M10 10h4v4h-4z'],
  checklist: ['M9 5h10', 'M9 12h10', 'M9 19h10', 'M4 5l1 1 2-2', 'M4 12l1 1 2-2', 'M4 19l1 1 2-2'],
  // Los vacíos de la app del personal: el ticket de un cobro, el banco que paga y el calendario de otras noches.
  receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6'],
  bank: ['M3 9.5L12 4l9 5.5', 'M4 9.5h16', 'M6 9.5v8', 'M10 9.5v8', 'M14 9.5v8', 'M18 9.5v8', 'M3 20h18'],
  calendar: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;

/** El dibujo, al tamaño y grosor que se pida (Etiqueta lo pinta a 14 con trazo de 3,4; los de aro, de 2,4). Siempre decorativo. */
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
