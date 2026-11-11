'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Logo } from '@nightpay/ui';
import { IconBack } from './icons';
import styles from './cobrar.module.css';

/** Color CSS de una sección (var(--np-sec-…)). */
export type SectionVar = string;

/**
 * Chip del puesto o la sección (Grafito): un punto de su color y el nombre,
 * sobre superficie neutra; el color nunca va solo. Sin color, solo el texto
 * («2 secciones»: los nombres van en las líneas).
 */
export function Chip({ color, children }: { color?: SectionVar | null; children: ReactNode }) {
  return (
    <span className={styles.chip}>
      {color ? <i style={{ '--c': color } as CSSProperties} aria-hidden="true" /> : null}
      <span className={styles.chipText}>{children}</span>
    </span>
  );
}

/**
 * Cabecera de las pantallas de cobrar (60 px, con su filete): el logo (o
 * «atrás»), el título, quién cobra y el chip del puesto o la sección. Sin
 * franja de color debajo (Grafito: la sección va en el chip, con su nombre).
 */
export function ScreenHeader({
  title,
  subtitle,
  chip,
  onBack,
  onLogo,
  extra,
  help,
}: {
  title: string;
  subtitle?: string | null;
  chip?: ReactNode;
  /** Con «atrás» en vez del logo. */
  onBack?: () => void;
  /** Tocar el logo (el menú: «Salir»). */
  onLogo?: () => void;
  /** Un botón más, antes del chip (p. ej. «Mi QR» de la chica). */
  extra?: ReactNode;
  /** El «?» con el tutorial de la pantalla (ScreenHelp), junto al logo. */
  help?: ReactNode;
}) {
  return (
    <header className={styles.head}>
      {onBack ? (
        <button type="button" className={styles.iconBtn} onClick={onBack} aria-label="Atrás">
          <IconBack />
        </button>
      ) : onLogo ? (
        <button type="button" className={styles.logoTile} onClick={onLogo} aria-label="Menú">
          <Logo variant="symbol" height="2.625rem" alt="" />
        </button>
      ) : (
        <Logo variant="symbol" height="2.625rem" />
      )}
      {help}
      <div className={styles.headText}>
        <b>{title}</b>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {extra}
      {chip}
    </header>
  );
}
