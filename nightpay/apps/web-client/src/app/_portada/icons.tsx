import type { ReactNode } from 'react';

/**
 * Iconos de la portada: SVG en línea, de trazo, dibujados para OxioPay (sin
 * fuentes de iconos ni librerías). Siempre decorativos: el texto de al lado
 * dice lo que hacen.
 */
export type IconName =
  | 'phone'
  | 'mail'
  | 'check'
  | 'x'
  | 'chevron'
  | 'arrow'
  | 'menu'
  | 'qr'
  | 'phoneQr'
  | 'cards'
  | 'shield'
  | 'tap'
  | 'screen'
  | 'bitcoin'
  | 'heart'
  | 'calendar'
  | 'people'
  | 'chart'
  | 'percent'
  | 'bell';

const PATHS: Record<IconName, ReactNode> = {
  phone: <path d="M5 4h3.5L10 8.5 8 10a11 11 0 0 0 6 6l1.5-2 4.5 1.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M7 7l10 10M17 7 7 17" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  qr: (
    <>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
      <path d="M6.5 6.5h.01M17.5 6.5h.01M6.5 17.5h.01M14.5 14.5H17v2.5M20.5 14.5h.01M14.5 20.5h.01M17.5 20.5h3v-3" />
    </>
  ),
  phoneQr: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10.5 5h3M9 9h2.5v2.5H9zM12.5 9H15v2.5h-2.5zM9 12.5h2.5V15H9zM13.5 13.5h.01M15 15h.01M12.5 15h.01M10.5 18.5h3" />
    </>
  ),
  cards: (
    <>
      <rect x="2.5" y="7.5" width="16" height="11" rx="2" />
      <path d="M6 4.5h13.5a2 2 0 0 1 2 2V15M2.5 11.5h16M5.5 15.5h3.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 19 6v5.5c0 4.4-3 7.7-7 9.5-4-1.8-7-5.1-7-9.5V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  tap: (
    <>
      <path d="M8.5 8.5a5 5 0 0 1 0 7M11.5 6a8.5 8.5 0 0 1 0 12M14.5 3.5a12 12 0 0 1 0 17" />
      <path d="M5.5 12h.01" />
    </>
  ),
  bitcoin: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.5 7.5v9M9.5 7.5H13a2.25 2.25 0 0 1 0 4.5H9.5M9.5 12h4a2.25 2.25 0 0 1 0 4.5h-4M11 6v1.5M13 6v1.5M11 16.5V18M13 16.5V18" />
    </>
  ),
  /** La tablet de la pantalla del cliente, con el importe y el QR. */
  screen: (
    <>
      <rect x="2.5" y="4.5" width="19" height="14" rx="2" />
      <path d="M6 8.5h5M6 11.5h3.5M14.5 8.5h3v3h-3zM9.5 21h5" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3 19.5a6 6 0 0 1 12 0M15.5 4.9a3.25 3.25 0 0 1 0 6.2M17.5 13.9a6 6 0 0 1 3.5 5.6" />
    </>
  ),
  chart: <path d="M4 20h16M7 16v-4M12 16V7M17 16v-7" />,
  percent: (
    <>
      <path d="M18 6 6 18" />
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="16.5" cy="16.5" r="2.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  /** Lado en px (por defecto 24). */
  size?: number;
  /** Grosor del trazo en unidades de la caja de 24 (por defecto 1.8). */
  stroke?: number;
  className?: string;
}

export function Icon({ name, size = 24, stroke = 1.8, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
