'use client';

import type { CSSProperties } from 'react';
import { chipTextColor, type SectionChipView } from '@/lib/money-map';

/** La sección de un cobro con su color (o «Varias», con el reparto al pasar por encima). */
export function SectionChip({ view }: { view: SectionChipView }) {
  if (!view.color) {
    return (
      <span title={view.title ?? undefined} style={{ ...chipStyle, ...neutralStyle }}>
        {view.label}
      </span>
    );
  }
  return (
    <span title={view.title ?? undefined} style={{ ...chipStyle, background: view.color, color: chipTextColor(view.color) }}>
      {view.label}
    </span>
  );
}

/** Puntito del color de una sección (carta, ajustes). */
export function SectionDot({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ ...dotStyle, background: color }} />;
}

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.1rem 0.55rem',
  borderRadius: '999px',
  fontSize: '0.75rem',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  lineHeight: 1.5,
};

const neutralStyle: CSSProperties = {
  background: 'var(--np-pill-mute-bg)',
  color: 'var(--np-text-mute)',
  border: '1px dashed var(--np-border-hi)',
};

const dotStyle: CSSProperties = {
  display: 'inline-block',
  width: '0.75rem',
  height: '0.75rem',
  borderRadius: '999px',
  flexShrink: 0,
};
