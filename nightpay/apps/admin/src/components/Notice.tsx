import type { CSSProperties, ReactNode } from 'react';
import { Banner } from '@nightpay/ui';
import type { Tone } from './Pill';

interface Props {
  tone: Tone;
  children: ReactNode;
  /** Botón al lado del mensaje (p. ej. "Reintentar"). */
  action?: { label: string; onClick: () => void };
  style?: CSSProperties;
}

/**
 * Aviso dentro de un panel: es la franja común (Banner), con su icono. Los
 * errores y los avisos se leen al aparecer; los resultados y los estados, sin
 * interrumpir.
 */
export function Notice({ tone, children, action, style }: Props) {
  return (
    <Banner tone={tone} action={action} style={style}>
      {children}
    </Banner>
  );
}
