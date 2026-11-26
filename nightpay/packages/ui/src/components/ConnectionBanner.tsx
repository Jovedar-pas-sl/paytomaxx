import type { CSSProperties } from 'react';
import type { ConnectionIssue, ConnectionIssueKind } from '../lib/connection';
import { Icon, type IconName } from './Icon';

interface ConnectionBannerProps {
  /** null: todo bien (no ocupa sitio). */
  issue: ConnectionIssue | null;
  className?: string;
  /** Márgenes para llegar a los bordes de la pantalla desde dentro del padding de la página. */
  style?: CSSProperties;
}

/**
 * Franja ámbar arriba que dice qué falla («Tu móvil no tiene internet»,
 * «OxioPay no responde…», «El banco está tardando») y qué hacer. Se queda
 * pegada arriba al hacer scroll sin tapar el contenido. La región de estado
 * existe siempre, vacía: así el lector de pantalla lee cada aviso nuevo.
 */
export function ConnectionBanner({ issue, className, style }: ConnectionBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={['np-conn-banner', className].filter(Boolean).join(' ')}
      data-open={issue ? 'true' : 'false'}
      data-kind={issue?.kind}
      style={style}
    >
      {issue ? (
        <div key={issue.kind} className="np-conn-banner-inner">
          <Icon name={BANNER_ICON[issue.kind]} className="np-conn-banner-icon" />
          <div>
            <p className="np-conn-banner-title">{issue.title}</p>
            <p className="np-conn-banner-hint">{issue.hint}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Wifi tachado (sin internet), la nube (OxioPay no responde) y el reloj de arena (el banco tarda). */
const BANNER_ICON: Record<ConnectionIssueKind, IconName> = { offline: 'wifi-off', server: 'cloud-download', bank: 'hourglass' };
