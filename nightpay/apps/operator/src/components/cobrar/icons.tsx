// Iconos de las maquetas (trazo de 2 px, del color del texto). Decorativos:
// el texto del botón o la etiqueta dicen lo que hacen.

import type { ReactNode } from 'react';

function Icon({ children, fill = false, width = 2 }: { children: ReactNode; fill?: boolean; width?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? undefined : 'currentColor'}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconBack = () => (
  <Icon width={2.2}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </Icon>
);

export const IconPlus = () => (
  <Icon width={2.4}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconMinus = () => (
  <Icon width={2.4}>
    <path d="M5 12h14" />
  </Icon>
);

export const IconDel = () => (
  <Icon>
    <path d="M9 5.5h10.5A1.5 1.5 0 0 1 21 7v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12l6-6.5z" />
    <path d="M12 9.5l5 5M17 9.5l-5 5" />
  </Icon>
);

export const IconLock = () => (
  <Icon>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const IconNfc = () => (
  <Icon>
    <path d="M5.5 10.5a2 2 0 0 1 0 3" />
    <path d="M9 8a6 6 0 0 1 0 8" />
    <path d="M12.5 5.5a9.5 9.5 0 0 1 0 13" />
    <path d="M16 3a13 13 0 0 1 0 18" />
  </Icon>
);

export const IconCheck = () => (
  <Icon width={2.4}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const IconQr = () => (
  <Icon>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2M20 14v.01M14 20h.01M17 17h3v3h-3z" />
  </Icon>
);

export const IconFlash = () => (
  <Icon>
    <path d="M13 2.5L5.5 13.5H11l-1 8 7.5-11H12l1-8z" />
  </Icon>
);

export const IconSun = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Icon>
);

export const IconHand = () => (
  <Icon>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v7M14 10.5V5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7-2.6 0-4-1.3-5.4-3.4L3.4 15a1.5 1.5 0 0 1 2.4-1.8L8 15.5" />
  </Icon>
);

export const IconMenu = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Icon>
);
