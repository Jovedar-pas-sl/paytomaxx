import type { ReactNode } from 'react';
import { CONTACT_EMAIL } from '@/lib/customer-pages';
import type { Point } from './content';
import { Icon } from './icons';
import c from './sections.module.css';
import s from '../landing.module.css';

/** El wordmark de OxioPay para fondo oscuro (hecho con las letras del logo de oxiocard). */
export const WORDMARK = { src: '/brand/oxiopay-wordmark-claro.png', width: 256, height: 51 } as const;

export const MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('OxioPay para mi local')}`;
export const PARTY_MAIL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('OxioParty para mi fiesta')}`;

export function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** La etiqueta pequeña con la raya delante («—— PAGOS Y FIDELIZACIÓN»). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx(s.eyebrow, className)}>{children}</p>;
}

/** Lista con la marca lima: «✓ Negrita: el resto». */
export function Points({ items }: { items: readonly Point[] }) {
  return (
    <ul className={c.points}>
      {items.map(([lead, text]) => (
        <li key={lead}>
          <Icon name="check" size={20} stroke={2.6} className={c.pointIcon} />
          <strong>{lead}</strong> {text}
        </li>
      ))}
    </ul>
  );
}
