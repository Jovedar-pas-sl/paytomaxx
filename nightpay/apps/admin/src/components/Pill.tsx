import type { CSSProperties, ReactNode } from 'react';
import { Etiqueta } from '@nightpay/ui';

// Los colores de cada tono viven con la Etiqueta (y con la franja, Banner, que pinta Notice).
export { TONE_COLORS } from '@nightpay/ui';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * Etiqueta de estado del panel: es la Etiqueta común (símbolo + palabra, el
 * color nunca va solo). `dot` ya no hace nada: todas llevan su símbolo.
 */
export function Pill({ tone, children, style }: { tone: Tone; children: ReactNode; style?: CSSProperties; dot?: boolean }) {
  return (
    <Etiqueta tone={tone} style={style}>
      {children}
    </Etiqueta>
  );
}
