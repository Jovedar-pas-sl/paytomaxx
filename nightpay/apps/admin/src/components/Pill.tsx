import type { CSSProperties, ReactNode } from 'react';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const TONE_COLORS: Record<Tone, { color: string; background: string }> = {
  success: { color: 'var(--np-success)', background: 'var(--np-pill-success-bg)' },
  warning: { color: 'var(--np-warning)', background: 'var(--np-pill-warning-bg)' },
  danger: { color: 'var(--np-danger)', background: 'var(--np-pill-danger-bg)' },
  // Informativo: neutro (el lima es para la acción y el «pagado»).
  info: { color: 'var(--np-text)', background: 'var(--np-pill-mute-bg)' },
  neutral: { color: 'var(--np-text-mute)', background: 'var(--np-pill-mute-bg)' },
};

/** Etiqueta de estado con texto y color (en vez de emojis como marcador). */
export function Pill({ tone, children, style, dot }: { tone: Tone; children: ReactNode; style?: CSSProperties; dot?: boolean }) {
  return (
    <span style={{ ...pillStyle, ...(dot ? { gap: '0.375rem' } : {}), ...TONE_COLORS[tone], ...style }}>
      {dot ? <span aria-hidden="true" style={dotStyle} /> : null}
      {children}
    </span>
  );
}

/** El punto de color del estado (el del texto de la etiqueta). */
const dotStyle: CSSProperties = { flex: 'none', width: '0.4375rem', height: '0.4375rem', borderRadius: '50%', background: 'currentColor' };

// Grafito: del tamaño del texto de la tabla (14/500), radio de chip (6).
const pillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 0.5rem',
  borderRadius: 'var(--np-r-xs)',
  fontSize: '0.875rem',
  fontWeight: 400,
  whiteSpace: 'nowrap',
  lineHeight: 1.45,
};
