import type { CSSProperties } from 'react';
import { cartaIconOf, type CartaIconCode } from '@nightpay/contracts';

/**
 * Los iconos de la carta: dibujos de línea propios (sin emojis ni logos de
 * marcas), sobre una cuadrícula de 24 px y con el color del texto
 * (currentColor). Los códigos y sus nombres están en @nightpay/contracts
 * (CARTA_ICONS); un test comprueba que no falta ninguno.
 */
export const CARTA_ICON_PATHS: Readonly<Record<CartaIconCode, readonly string[]>> = {
  copa: ['M8 4h8c1 0 1.5.8 1.3 1.6C16.5 9 15 12 12 12S7.5 9 6.7 5.6C6.5 4.8 7 4 8 4Z', 'M12 12v6.5', 'M8.5 20.5h7'],
  gin_tonic: ['M7 7h10l-1.2 12a1.5 1.5 0 0 1-1.5 1.4H9.7A1.5 1.5 0 0 1 8.2 19L7 7Z', 'M7.6 12h8.8', 'M13.5 7l2-4.5', 'M17.6 5.2a2.3 2.3 0 1 0 .01 0'],
  cerveza: [
    'M6 8h9v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8Z',
    'M15 10h2.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H15',
    'M6 8a2 2 0 0 1 1-3.4 2.3 2.3 0 0 1 3.5-.6 2.3 2.3 0 0 1 3.5.6A2 2 0 0 1 15 8',
    'M9.5 12v5',
    'M12 12v5',
  ],
  cava: ['M9.5 3h5l-.6 9a2 2 0 0 1-3.8 0L9.5 3Z', 'M12 14.2V20', 'M9 20.5h6', 'M11.3 7h.01', 'M12.9 9.5h.01', 'M18.5 4v3.4', 'M16.8 5.7h3.4'],
  vino: ['M8 3h8l.5 5a4.5 4.5 0 0 1-9 0L8 3Z', 'M7.6 8h8.8', 'M12 12.5v7', 'M8.5 20.5h7'],
  chupito: ['M8 7h8l-1 11a1.5 1.5 0 0 1-1.5 1.4h-3A1.5 1.5 0 0 1 9 18L8 7Z', 'M8.4 11.5h7.2', 'M16 7l2.5-3.5'],
  coctel: ['M4 5h16l-8 8-8-8Z', 'M12 13v7', 'M8 20.5h8', 'M15.5 2.5 11.5 9'],
  refresco: ['M8 5h8v14a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 8 19V5Z', 'M8 5c0-1.1 1.7-1.7 4-1.7S16 3.9 16 5', 'M8 9.5h8', 'M8 14.5h8'],
  agua: ['M12 3.5c3.5 4 5.5 6.8 5.5 9.5a5.5 5.5 0 0 1-11 0c0-2.7 2-5.5 5.5-9.5Z', 'M9.6 13.6a2.8 2.8 0 0 0 2 2.6'],
  zumo: ['M12 4a8 8 0 1 0 .01 0', 'M12 12V7.4', 'M12 12l4 2.3', 'M12 12l-4 2.3'],
  botella: ['M10 3h4v4c0 1.2 2.5 2 2.5 5v7.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V12C7.5 9 10 8.2 10 7V3Z', 'M7.5 13h9v4.5h-9z'],
  cafe: [
    'M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9Z',
    'M16 10.5h1.5a2.5 2.5 0 0 1 0 5H15.6',
    'M8.5 3.5c-.9 1 .9 1.9 0 3',
    'M12 3.5c-.9 1 .9 1.9 0 3',
    'M4 21.5h13',
  ],
  entrada: ['M4 7h16v3.2a2 2 0 0 0 0 3.6V17H4v-3.2a2 2 0 0 0 0-3.6V7Z', 'M14.5 7.5v1.6', 'M14.5 11.2v1.6', 'M14.5 14.9v1.6', 'M7.5 10.5h4', 'M7.5 13.5h3'],
  entrada_copa: ['M2.5 11.5h12v2.2a1.6 1.6 0 0 0 0 2.9v2.4h-12v-2.4a1.6 1.6 0 0 0 0-2.9v-2.2Z', 'M10 12v1.4', 'M10 15.2v1.4', 'M14 3h8l-4 4.6L14 3Z', 'M18 7.6v3.4', 'M16 11.2h4'],
  habitacion: ['M4 5v14', 'M4 15.5h16.5', 'M20.5 19.5v-6.5a3 3 0 0 0-3-3H11v5.5', 'M7.5 12.3a1.7 1.7 0 1 0 .01 0'],
  reservado: ['M5 4.5v15.5', 'M19 4.5v15.5', 'M5 8c3 5.4 11 5.4 14 0', 'M3 20.5h4', 'M17 20.5h4', 'M3.8 4.5h2.4', 'M17.8 4.5h2.4'],
  nachos: ['M3 19 9 7l6 12H3Z', 'M10.5 19 15.7 8 21 19H10.5Z', 'M8.5 15.3h.01', 'M15.7 15.3h.01'],
  tapa: ['M4.5 17v-3.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2V17a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z', 'M11 6a2.2 2.2 0 1 0 .01 0', 'M11 8.2v3.3', 'M11 6V2.8', 'M3 20.5h18'],
  tabla: ['M3.5 18h17v-6L3.5 8v10Z', 'M8.5 15h.01', 'M13 15.6h.01', 'M16.4 13.6h.01', 'M3 21h18'],
  hamburguesa: ['M4 11a8 6 0 0 1 16 0H4Z', 'M4 14h16', 'M4 17h16a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z', 'M9 8.5h.01', 'M12 7.3h.01', 'M15 8.5h.01'],
  postre: ['M7 11a5 5 0 1 1 10 0H7Z', 'M7.6 11 12 21l4.4-10', 'M9.6 15h4.8'],
  cachimba: ['M9.5 3.5h5L14 6.5h-4l-.5-3Z', 'M12 6.5V13', 'M9.3 10h5.4', 'M8.5 13.5h7l1 6a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 19.5l1-6Z', 'M15.8 15.5c2.8 0 4.2-1 4.2-4V8'],
  ticket: ['M6 3h12v18l-2.25-1.5L13.5 21 12 19.5 10.5 21l-2.25-1.5L6 21V3Z', 'M9 8h6', 'M9 12h6', 'M9 16h3'],
  estrella: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8L12 3.5Z'],
  plato: ['M4 17a8 8 0 0 1 16 0H4Z', 'M12 9V6.6', 'M10.4 6.6h3.2', 'M3 20.5h18'],
};

interface CartaIconProps {
  /** El código del icono (CARTA_ICONS). */
  code: CartaIconCode;
  /** Lado en px (por defecto 28). */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** Un icono de la carta, solo decorativo (el nombre del producto va al lado). */
export function CartaIcon({ code, size = 28, className, style }: CartaIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      {CARTA_ICON_PATHS[code].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** El icono de un producto de la carta: el suyo o, si no tiene, el de su sección. */
export function CartaItemIcon({ item, size, className, style }: Omit<CartaIconProps, 'code'> & { item: { icon?: string | null; category: string } }) {
  return <CartaIcon code={cartaIconOf(item)} size={size} className={className} style={style} />;
}
