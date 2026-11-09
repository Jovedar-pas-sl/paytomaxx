'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Logo } from '@nightpay/ui';
import { IconBack } from './icons';
import styles from './cobrar.module.css';

/** Color CSS de una sección (var(--np-sec-…)). */
export type SectionVar = string;

/** Pill de color (el puesto, la sección, «2 secciones»). Con dos colores, partida. */
export function Chip({ colors, children }: { colors: readonly SectionVar[]; children: ReactNode }) {
  const [c, c2] = colors;
  return (
    <span className={`${styles.chip}${c2 ? ` ${styles.chipDuo}` : ''}`} style={{ '--c': c, '--c2': c2 } as CSSProperties}>
      {children}
    </span>
  );
}

/** La franja bajo la cabecera: de qué es el cobro (se parte con varias secciones). */
export function Stripe({
  parts,
  height,
}: {
  parts: ReadonlyArray<{ color: SectionVar; weight: number }>;
  height?: string;
}) {
  return (
    <div className={styles.stripe} style={height ? { height } : undefined} aria-hidden="true">
      {parts.map((p, i) => (
        <i key={i} style={{ '--c': p.color, flex: Math.max(p.weight, 1) } as CSSProperties} />
      ))}
    </div>
  );
}

/**
 * Cabecera de las pantallas de cobrar (maqueta «ah»): la loseta del logo (o
 * «atrás»), el título, quién cobra y el chip del puesto o la sección.
 */
export function ScreenHeader({
  title,
  subtitle,
  chip,
  onBack,
  onLogo,
  extra,
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
      <div className={styles.headText}>
        <b>{title}</b>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {extra}
      {chip}
    </header>
  );
}
