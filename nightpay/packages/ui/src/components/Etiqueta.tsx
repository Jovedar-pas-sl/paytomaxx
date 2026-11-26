import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { sectionOf, sectionVar } from '../lib/sections';
import { IconSvg, type IconName } from './Icon';

/** Los tonos comunes de las apps y los dos propios de un cobro: `wait` (esperando) y `refund` (devuelto). */
export type EtiquetaTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'wait' | 'refund';

/** El color del texto de cada tono y su fondo teñido (el texto encima, ≥ 4,5:1: lo mide styles.css). */
export const TONE_COLORS: Record<EtiquetaTone, { color: string; background: string }> = {
  success: { color: 'var(--np-success)', background: 'var(--np-pill-success-bg)' },
  warning: { color: 'var(--np-warning)', background: 'var(--np-pill-warning-bg)' },
  danger: { color: 'var(--np-danger)', background: 'var(--np-pill-danger-bg)' },
  // Informativo: neutro (el lima es para la acción y el «pagado»).
  info: { color: 'var(--np-text)', background: 'var(--np-pill-mute-bg)' },
  neutral: { color: 'var(--np-text-mute)', background: 'var(--np-pill-mute-bg)' },
  wait: { color: 'var(--np-text)', background: 'var(--np-pill-mute-bg)' },
  refund: { color: 'var(--np-purple)', background: 'var(--np-pill-purple-bg)' },
};

/** El símbolo de cada tono: el color nunca va solo. El neutro lleva un punto. */
const TONE_ICON: Record<Exclude<EtiquetaTone, 'neutral'>, IconName> = {
  success: 'check',
  warning: 'alert',
  danger: 'error',
  info: 'info',
  wait: 'clock',
  refund: 'undo',
};

/**
 * Los dibujos con aro van más finos (2,4, el trazo de Icon a 20): a 14 px y con
 * el 3,4 de los demás (2 px a la vista) el punto y el palo del «!» y de la «i»
 * se tocan entre sí y con el aro, y los dos se leen como una barra en un círculo.
 */
const RINGED: readonly IconName[] = ['alert', 'info', 'clock'];

type SpanProps = Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'children'>;

interface SectionProps extends SpanProps {
  tone?: undefined;
  /** Categoría del cobro (VENUE_BAR…) o clave de la sección (copas…). Sobra con `label` y `color`. */
  section?: string;
  /** El nombre que se enseña; sin él, el de la sección («Copas»). */
  label?: string;
  /** El color del punto (el que eligió el local); sin él, el de la sección. `null` es «Varias»: punto a trazos. */
  color?: string | null;
  children?: undefined;
}

interface StateProps extends SpanProps {
  tone: EtiquetaTone;
  /** La palabra del estado («Pagado»). */
  children: ReactNode;
  /** Mientras espera: el punto que late en lugar del símbolo. */
  pulse?: boolean;
  /** `sm` 24 px (tablas) · `md` 32 px. Sin decirlo: 24, y 32 en la app táctil. */
  size?: 'sm' | 'md';
}

/**
 * LA etiqueta de las apps (también `Tag`). De sección: el punto de su color y
 * su nombre (es el .np-chip de siempre). De estado (`tone`): su símbolo y su
 * palabra sobre el fondo teñido del tono. No es un botón.
 */
export function Etiqueta(props: SectionProps | StateProps) {
  if (props.tone === undefined) {
    const { section, label, color, className, style, ...rest } = props;
    const info = sectionOf(section);
    const dot = color ?? (color === null ? undefined : sectionVar(section));
    return (
      <span
        {...rest}
        className={['np-chip', className].filter(Boolean).join(' ')}
        data-section={info?.key}
        data-dashed={info?.dashed || undefined}
        data-mixed={color === null || undefined}
        style={dot ? ({ '--np-c': dot, ...style } as CSSProperties) : style}
      >
        {label ?? info?.label ?? section}
      </span>
    );
  }
  const { tone, pulse, size, children, className, style, ...rest } = props;
  return (
    <span {...rest} className={['np-tag', className].filter(Boolean).join(' ')} data-tone={tone} data-size={size} style={{ ...TONE_COLORS[tone], ...style }}>
      {pulse ? (
        <span aria-hidden="true" className="np-tag-mark np-tag-pulse" />
      ) : tone === 'neutral' ? (
        <span aria-hidden="true" className="np-tag-mark np-tag-dot" />
      ) : (
        <IconSvg name={TONE_ICON[tone]} size={14} strokeWidth={RINGED.includes(TONE_ICON[tone]) ? 2.4 : 3.4} className="np-tag-mark" />
      )}
      {children}
    </span>
  );
}

export { Etiqueta as Tag };
