import type { CSSProperties } from 'react';
import type { ConnectionIssue, ConnectionIssueKind } from '../lib/connection';

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
          <BannerIcon kind={issue.kind} />
          <div>
            <p className="np-conn-banner-title">{issue.title}</p>
            <p className="np-conn-banner-hint">{issue.hint}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BannerIcon({ kind }: { kind: ConnectionIssueKind }) {
  return (
    <svg
      className="np-conn-banner-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'offline' ? (
        // Wifi tachado.
        <>
          <path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0" />
          <circle cx="12" cy="19" r="1" fill="currentColor" />
          <path d="M3 3l18 18" />
        </>
      ) : kind === 'server' ? (
        // Nube con flechas de reintento.
        <>
          <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 7.97" />
          <path d="M12 12v6M9.5 15.5L12 18l2.5-2.5" />
        </>
      ) : (
        // Reloj de arena: el banco tarda.
        <path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" />
      )}
    </svg>
  );
}
