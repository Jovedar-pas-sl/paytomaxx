import type { CSSProperties, ReactNode } from 'react';
import { sectionOf, sectionVar } from '../lib/sections';

interface SectionChipProps {
  /** Categoría del cobro (VENUE_BAR…) o clave de la sección (copas…). */
  section: string;
  /** Texto del chip. Por defecto, el nombre de la sección («Copas»). */
  children?: ReactNode;
}

/** Pill del color de la sección (estilos en styles.css: .np-chip). */
export function SectionChip({ section, children }: SectionChipProps) {
  const info = sectionOf(section);
  return (
    <span
      className="np-chip"
      data-section={info?.key}
      data-dashed={info?.dashed || undefined}
      style={{ '--np-c': sectionVar(section) } as CSSProperties}
    >
      {children ?? info?.label ?? section}
    </span>
  );
}
