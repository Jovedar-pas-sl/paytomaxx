'use client';

import type { CSSProperties } from 'react';
import { Etiqueta } from '@nightpay/ui';
import type { SectionChipView } from '@/lib/money-map';

/**
 * La sección de un cobro: el punto de su color y su nombre (o «Varias», con el
 * punto a trazos y el reparto al pasar por encima). Es la Etiqueta común.
 */
export function SectionChip({ view }: { view: SectionChipView }) {
  return <Etiqueta label={view.label} color={view.color} title={view.title ?? undefined} />;
}

/** Puntito del color de una sección (carta, ajustes). */
export function SectionDot({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ ...dotStyle, background: color }} />;
}

const dotStyle: CSSProperties = {
  display: 'inline-block',
  width: '0.75rem',
  height: '0.75rem',
  borderRadius: '999px',
  flexShrink: 0,
};
