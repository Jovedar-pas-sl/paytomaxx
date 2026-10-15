import type { CSSProperties, ReactNode } from 'react';
import { Button } from '@nightpay/ui';
import { TONE_COLORS, type Tone } from './Pill';

interface Props {
  tone: Tone;
  children: ReactNode;
  /** Botón al lado del mensaje (p. ej. "Reintentar"). */
  action?: { label: string; onClick: () => void };
  style?: CSSProperties;
}

/**
 * Aviso dentro de un panel: errores (role=alert, se leen al aparecer) y
 * resultados o estados (role=status).
 */
export function Notice({ tone, children, action, style }: Props) {
  const { color, background } = TONE_COLORS[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      style={{ ...boxStyle, borderColor: color, background, ...style }}
    >
      <div style={{ flex: '1 1 14rem', color: 'var(--np-text)' }}>{children}</div>
      {action ? (
        <Button variant="ghost" type="button" onClick={action.onClick} style={actionStyle}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

const boxStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
  padding: '0.75rem 1rem',
  border: '1px solid',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.875rem',
  lineHeight: 1.45,
};

const actionStyle: CSSProperties = { height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' };
