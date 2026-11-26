import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button';
import { TONE_COLORS } from './Etiqueta';
import { Icon, IconButton, type IconName } from './Icon';

type BannerTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** El dibujo de cada tono: el color nunca va solo. */
const TONE_ICON: Record<BannerTone, IconName> = {
  success: 'check',
  warning: 'alert',
  danger: 'error',
  info: 'info',
  neutral: 'info',
};

interface BannerProps {
  tone: BannerTone;
  /** Una línea en negrita delante del texto. */
  title?: string;
  children: ReactNode;
  /** Un botón junto al mensaje («Reintentar»): a la derecha, o debajo si no cabe. */
  action?: { label: string; onClick: () => void };
  /** Con él, la ✕ «Cerrar aviso». Sin él, la franja se queda mientras dure lo que cuenta. */
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * La franja: un estado que dura (falta la cuenta de cobro, no hay conexión con
 * el banco, algo no se pudo cargar). Se queda hasta que deja de ser verdad: no
 * tiene reloj. Los errores y los avisos (danger y warning) se leen al aparecer
 * (role="alert"); lo demás, role="status". Estilos en pieces-2.css: .np-banner.
 */
export function Banner({ tone, title, children, action, onClose, className, style }: BannerProps) {
  const { color, background } = TONE_COLORS[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={['np-banner', className].filter(Boolean).join(' ')}
      data-tone={tone}
      style={{ '--np-banner-c': color, background, ...style } as CSSProperties}
    >
      <Icon name={TONE_ICON[tone]} size={20} />
      <div className="np-banner-main">
        <div className="np-banner-text">
          {title ? <strong className="np-banner-title">{title}</strong> : null}
          {children}
        </div>
        {action ? (
          <Button variant="ghost" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </div>
      {onClose ? <IconButton icon="close" label="Cerrar aviso" className="np-banner-close" onClick={onClose} /> : null}
    </div>
  );
}
