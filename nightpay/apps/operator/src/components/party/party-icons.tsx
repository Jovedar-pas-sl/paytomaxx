// Iconos de las pantallas de OxioParty (los trazos de las maquetas). Trazo en
// currentColor: heredan el color de su sitio; siempre aria-hidden (el texto va al lado).

import type { ReactNode } from 'react';
import type { TileIcon } from '@/lib/party-barra';

function Svg({ size, width = 2, children }: { size: number; width?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** El «⋯» del menú. */
export const IconDots = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

export const IconMinusSm = ({ size = 16 }: { size?: number }) => (
  <Svg size={size} width={2.4}>
    <path d="M5 12h14" />
  </Svg>
);

export const IconPlusSm = ({ size = 16 }: { size?: number }) => (
  <Svg size={size} width={2.4}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

/** Las ondas de la pulsera (sin contacto): «Cobrar» y el cuadro de la pulsera leída. */
export const IconNfcWaves = ({ size = 22 }: { size?: number }) => (
  <Svg size={size} width={2.2}>
    <path d="M8 9a5 5 0 0 1 0 6" />
    <path d="M11.5 6.5a9 9 0 0 1 0 11" />
    <path d="M15 4a13 13 0 0 1 0 16" />
  </Svg>
);

/** El billete (efectivo). */
export const IconCash = () => (
  <Svg size={20}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6 12h.01M18 12h.01" />
  </Svg>
);

/** La tarjeta. */
export const IconCard = () => (
  <Svg size={20}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M2.5 10h19" />
    <path d="M6.5 15h4" />
  </Svg>
);

/** La «i» del aviso de la tarjeta. */
export const IconInfo = () => (
  <Svg size={20}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Svg>
);

/** El ticket de la taquilla (su cuadro de la cabecera). */
export const IconTicket = () => (
  <Svg size={20}>
    <path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
    <path d="M14 5v14" strokeDasharray="2 2.5" />
  </Svg>
);

/** El icono de cada loseta, por su sección: vaso, cubiertos, entrada o etiqueta. */
export function TileGlyph({ icon }: { icon: TileIcon }) {
  if (icon === 'drink') {
    return (
      <Svg size={17}>
        <path d="M6 3h12l-1.6 17.1a1 1 0 0 1-1 .9H8.6a1 1 0 0 1-1-.9L6 3z" />
        <path d="M6.6 9h10.8" />
      </Svg>
    );
  }
  if (icon === 'food') {
    return (
      <Svg size={17}>
        <path d="M7 3v7a2 2 0 0 0 4 0V3" />
        <path d="M9 12v9" />
        <path d="M17 21V3c-2 1-3 3.2-3 6.5V14h3" />
      </Svg>
    );
  }
  if (icon === 'ticket') {
    return (
      <Svg size={17}>
        <path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
      </Svg>
    );
  }
  return (
    <Svg size={17}>
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </Svg>
  );
}
